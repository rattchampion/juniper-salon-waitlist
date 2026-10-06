import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";
import type {
  FindNextResult,
  OpeningInfo,
  OpeningInput,
  OpeningView,
  TextKind,
  WaitlistClient,
} from "../src/types";
import {
  backOut,
  cancelOpening,
  fillOpeningWorkflow,
  getOpeningView,
  respondToOffer,
} from "../src/workflows";

// A fresh time-skipping server per test, so one test fast-forwarding the clock
// can never affect another.
let env: TestWorkflowEnvironment;
beforeEach(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});
afterEach(async () => {
  await env.teardown();
});

const person = (id: string): WaitlistClient => ({
  id,
  name: `${id.toUpperCase()} Person`,
  phone: "(555) 010-0000",
  service: "Haircut",
  preferredStylist: null,
  availability: ["morning", "afternoon", "evening"],
  addedAt: "2030-01-01T00:00:00Z",
  optedOut: false,
  textBehavior: "ok",
});

// Stand-ins for the real activities, so these tests exercise only the Workflow.
function fakeActivities(clients: WaitlistClient[], failOffersFor: string[] = []) {
  const calls = { contacted: [] as string[][], sent: [] as { kind: TextKind; clientId: string }[], booked: [] as string[], released: 0 };
  return {
    calls,
    activities: {
      async findNextEligible(args: { opening: OpeningInfo; contactedIds: string[] }): Promise<FindNextResult> {
        calls.contacted.push([...args.contactedIds]);
        const left = clients.filter((c) => !args.contactedIds.includes(c.id));
        const [next, ...rest] = left;
        return { next: next ?? null, stillEligible: rest.map((c) => ({ id: c.id, name: c.name })), notEligible: [] };
      },
      async sendText(args: { kind: TextKind; client: WaitlistClient }) {
        if (args.kind === "offer" && failOffersFor.includes(args.client.id)) throw new Error("carrier");
        calls.sent.push({ kind: args.kind, clientId: args.client.id });
        return { delivered: true as const };
      },
      async bookInSquare(args: { client: WaitlistClient }) {
        calls.booked.push(args.client.id);
      },
      async cancelInSquare() {
        calls.released += 1;
      },
    },
  };
}

let counter = 0;
async function withOpening(
  fake: ReturnType<typeof fakeActivities>,
  run: (handle: WorkflowHandle<typeof fillOpeningWorkflow>) => Promise<void>,
  startsInMs = 3 * 60 * 60_000,
) {
  const taskQueue = `test-${++counter}`;
  // Use the test server's clock: earlier tests fast-forward it.
  const now = await env.currentTimeMs();
  const input: OpeningInput = {
    openingId: `opening-${counter}`,
    service: "Haircut",
    stylist: "Jenna",
    startsAt: new Date(now + startsInMs).toISOString(),
    timing: "real",
    replyWindowMs: 15 * 60_000,
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("../src/workflows"),
    activities: fake.activities,
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(fillOpeningWorkflow, {
      workflowId: input.openingId,
      taskQueue,
      args: [input],
    });
    await run(handle);
  });
}

async function waitFor(
  handle: WorkflowHandle<typeof fillOpeningWorkflow>,
  predicate: (v: OpeningView) => boolean,
): Promise<OpeningView> {
  for (let i = 0; i < 200; i++) {
    const v = await handle.query(getOpeningView);
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition never became true");
}
const offeredTo = (id: string) => (v: OpeningView) => v.currentOffer?.clientId === id;
type ReplyArgs = [{ clientId: string; response: "accept" | "decline" }];
const accept = (id: string): { args: ReplyArgs } => ({ args: [{ clientId: id, response: "accept" }] });
const decline = (id: string): { args: ReplyArgs } => ({ args: [{ clientId: id, response: "decline" }] });

test("the first client accepts and is booked, then confirmed", async () => {
  const fake = fakeActivities([person("a"), person("b")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    const reply = await handle.executeUpdate(respondToOffer, accept("a"));
    assert.equal(reply.result, "accepted");
    const final = await handle.result();
    assert.equal(final.status, "completed");
    assert.equal(final.acceptedBy?.id, "a");
  });
  assert.deepEqual(fake.calls.booked, ["a"]);
  assert.deepEqual(fake.calls.sent, [
    { kind: "offer", clientId: "a" },
    { kind: "confirmation", clientId: "a" },
  ]);
});

test("when the first client doesn't reply in time, they are told and the next person is asked", async () => {
  const fake = fakeActivities([person("a"), person("b")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    await env.sleep(16 * 60_000); // longer than the 15-minute reply window
    const view = await waitFor(handle, offeredTo("b"));
    assert.ok(view.history.some((h) => h.kind === "timed_out" && h.clientId === "a"));
    await handle.executeUpdate(respondToOffer, accept("b"));
    assert.equal((await handle.result()).acceptedBy?.id, "b");
  });
  assert.ok(fake.calls.sent.some((m) => m.kind === "unavailable" && m.clientId === "a"));
  assert.deepEqual(fake.calls.contacted[1], ["a"], "the same person is never offered the spot twice");
});

test("only one person can get the spot, even if answers arrive together", async () => {
  const fake = fakeActivities([person("a"), person("b")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    const [first, second, other] = await Promise.all([
      handle.executeUpdate(respondToOffer, accept("a")),
      handle.executeUpdate(respondToOffer, accept("a")),
      handle.executeUpdate(respondToOffer, accept("b")),
    ]);
    const results = [first.result, second.result, other.result].sort();
    assert.deepEqual(results, ["accepted", "already_accepted", "unavailable"]);
    assert.equal((await handle.result()).acceptedBy?.id, "a");
  });
  assert.deepEqual(fake.calls.booked, ["a"]);
});

test("a late reply after the offer expired is told the spot is gone and is not booked", async () => {
  const fake = fakeActivities([person("a"), person("b")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    await env.sleep(16 * 60_000);
    await waitFor(handle, offeredTo("b"));
    const late = await handle.executeUpdate(respondToOffer, accept("a"));
    assert.equal(late.result, "unavailable");
    assert.equal((await handle.query(getOpeningView)).acceptedBy, null);
  });
  assert.deepEqual(fake.calls.booked, []);
});

test("staff can stop an offer that is out, and the client is told", async () => {
  const fake = fakeActivities([person("a"), person("b")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    const stopped = await handle.executeUpdate(cancelOpening, { args: [{ reason: "filled another way" }] });
    assert.equal(stopped.ok, true);
    const final = await handle.result();
    assert.equal(final.status, "cancelled");
    assert.match(final.endedReason ?? "", /filled another way/);
  });
  assert.ok(fake.calls.sent.some((m) => m.kind === "unavailable" && m.clientId === "a"));
  assert.equal(fake.calls.sent.filter((m) => m.kind === "offer").length, 1, "nobody else is texted after the stop");
});

test("if a text can't be delivered, the next person is asked", async () => {
  const fake = fakeActivities([person("a"), person("b")], ["a"]);
  await withOpening(fake, async (handle) => {
    const view = await waitFor(handle, offeredTo("b"));
    assert.ok(view.history.some((h) => h.kind === "text_failed" && h.clientId === "a"));
    await handle.executeUpdate(respondToOffer, accept("b"));
    await handle.result();
  });
});

test("if someone accepts and then backs out, the spot reopens for the next person", async () => {
  const fake = fakeActivities([person("a"), person("b")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    await handle.executeUpdate(respondToOffer, accept("a"));
    await waitFor(handle, (v) => v.history.some((h) => h.kind === "confirmed"));
    const released = await handle.executeUpdate(backOut, { args: [{ clientId: "a" }] });
    assert.equal(released.ok, true);
    await waitFor(handle, offeredTo("b"));
    await handle.executeUpdate(respondToOffer, accept("b"));
    const final = await handle.result();
    assert.equal(final.acceptedBy?.id, "b");
  });
  assert.equal(fake.calls.released, 1);
  assert.deepEqual(fake.calls.booked, ["a", "b"]);
});

test("when everyone declines, the spot is marked unfilled and the process stops", async () => {
  const fake = fakeActivities([person("a")]);
  await withOpening(fake, async (handle) => {
    await waitFor(handle, offeredTo("a"));
    await handle.executeUpdate(respondToOffer, decline("a"));
    const final = await handle.result();
    assert.equal(final.status, "unfilled");
    assert.match(final.endedReason ?? "", /No one else/);
  });
});

test("too close to the appointment, nobody is offered the spot", async () => {
  const fake = fakeActivities([person("a")]);
  await withOpening(
    fake,
    async (handle) => {
      const final = await handle.result();
      assert.equal(final.status, "unfilled");
      assert.match(final.endedReason ?? "", /Too close/);
    },
    20 * 60_000, // inside the 30-minute cutoff
  );
  assert.deepEqual(fake.calls.sent, []);
});
