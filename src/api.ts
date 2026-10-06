import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client, Connection } from "@temporalio/client";
import express, { type Request, type Response } from "express";
import {
  defaultStart,
  getOpeningIds,
  getOutbox,
  getWaitlist,
  registerOpening,
  resetDemoData,
  workerIsOnline,
} from "./store";
import type { OfferReplyResult, OpeningInput, OpeningView, ServiceName, SimpleResult } from "./types";
import {
  DEMO_REPLY_WINDOW_MS,
  FUTURE_DAY_REPLY_WINDOW_MS,
  SAME_DAY_REPLY_WINDOW_MS,
  SERVICE_MINUTES,
  SERVICE_NAMES,
  STYLISTS,
  TASK_QUEUE,
  UNAVAILABLE_MESSAGE,
} from "./types";
import { backOut, cancelOpening, fillOpeningWorkflow, getOpeningView, respondToOffer } from "./workflows";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);

// Running openings are asked directly; finished ones return their final view.
async function loadView(openingId: string): Promise<OpeningView | null> {
  const client = await getClient();
  const handle = client.workflow.getHandle(openingId);
  try {
    const description = await withTimeout(handle.describe(), 3000);
    if (description.status.name === "RUNNING") {
      return await withTimeout(handle.query(getOpeningView), 3000);
    }
    return await withTimeout(handle.result(), 3000);
  } catch {
    return null; // e.g. the Worker is not running
  }
}

function sameDay(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}

// ---- Staff ----------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  let temporal = true;
  try {
    const client = await getClient();
    await withTimeout(client.workflowService.getSystemInfo({}), 2000);
  } catch {
    temporal = false;
  }
  res.json({ temporal, worker: workerIsOnline() });
});

app.get("/api/defaults", (_req, res) => {
  res.json({
    startsAt: defaultStart().toISOString(),
    services: SERVICE_NAMES.map((name) => ({ name, minutes: SERVICE_MINUTES[name] })),
    stylists: STYLISTS,
  });
});

app.post("/api/openings", async (req: Request, res: Response) => {
  const { service, stylist, startsAt, timing } = req.body as {
    service: ServiceName;
    stylist: string;
    startsAt: string;
    timing: "demo" | "real";
  };
  if (!SERVICE_NAMES.includes(service) || !STYLISTS.includes(stylist as never) || Number.isNaN(Date.parse(startsAt))) {
    res.status(400).json({ error: "Please choose a service, stylist, and a valid time." });
    return;
  }
  if (Date.parse(startsAt) <= Date.now()) {
    res.status(400).json({ error: "That time has already passed." });
    return;
  }
  const mode = timing === "demo" ? "demo" : "real";
  const input: OpeningInput = {
    openingId: `opening-${randomUUID().slice(0, 8)}`,
    service,
    stylist,
    startsAt,
    timing: mode,
    replyWindowMs:
      mode === "demo"
        ? DEMO_REPLY_WINDOW_MS
        : sameDay(startsAt)
          ? SAME_DAY_REPLY_WINDOW_MS
          : FUTURE_DAY_REPLY_WINDOW_MS,
  };
  const client = await getClient();
  await client.workflow.start(fillOpeningWorkflow, {
    workflowId: input.openingId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  registerOpening(input.openingId);
  res.status(201).json({ openingId: input.openingId });
});

app.get("/api/openings", async (_req, res) => {
  const ids = [...getOpeningIds()].reverse();
  const views = await Promise.all(ids.map(loadView));
  res.json({
    openings: ids.map((id, i) => ({ id, view: views[i] })),
  });
});

app.post("/api/openings/:id/cancel", async (req, res) => {
  const reason = String((req.body as { reason?: string }).reason ?? "filled another way");
  const client = await getClient();
  const result = await client.workflow
    .getHandle(String(req.params.id))
    .executeUpdate<SimpleResult, [{ reason: string }]>(cancelOpening, { args: [{ reason }] });
  res.json(result);
});

app.get("/api/waitlist", (_req, res) => res.json({ waitlist: getWaitlist() }));
app.get("/api/outbox", (_req, res) => res.json({ outbox: [...getOutbox()].reverse().slice(0, 60) }));

app.post("/api/reset-demo", (_req, res) => {
  resetDemoData();
  res.json({ ok: true });
});

// ---- Client link (no account needed) --------------------------------------

type ClaimState = "offer" | "accepted" | "declined" | "unavailable";

app.get("/api/claim/:openingId/:clientId", async (req, res) => {
  const { openingId, clientId } = req.params as { openingId: string; clientId: string };
  const person = getWaitlist().find((c) => c.id === clientId);
  const view = await loadView(openingId);
  if (!person || !view) {
    res.json({ state: "unavailable" satisfies ClaimState, message: UNAVAILABLE_MESSAGE });
    return;
  }
  let state: ClaimState = "unavailable";
  if (view.acceptedBy?.id === clientId) state = "accepted";
  else if (view.currentOffer?.clientId === clientId) state = "offer";
  else if (view.history.some((h) => h.kind === "declined" && h.clientId === clientId)) state = "declined";
  res.json({
    state,
    firstName: person.name.split(" ")[0],
    service: person.service,
    stylist: view.opening.stylist,
    startsAt: view.opening.startsAt,
    expiresAt: view.currentOffer?.clientId === clientId ? view.currentOffer.expiresAt : null,
    message: state === "unavailable" ? UNAVAILABLE_MESSAGE : null,
  });
});

app.post("/api/claim/:openingId/:clientId/respond", async (req, res) => {
  const { openingId, clientId } = req.params as { openingId: string; clientId: string };
  const response = (req.body as { response?: string }).response === "accept" ? "accept" : "decline";
  try {
    const client = await getClient();
    const result = await withTimeout(
      client.workflow
        .getHandle(openingId)
        .executeUpdate<OfferReplyResult, [{ clientId: string; response: "accept" | "decline" }]>(
          respondToOffer,
          { args: [{ clientId, response }] },
        ),
      5000,
    );
    res.json(result);
  } catch {
    // The workflow has finished (or cannot be reached): the spot is gone.
    res.json({ result: "unavailable", message: UNAVAILABLE_MESSAGE } satisfies OfferReplyResult);
  }
});

app.post("/api/claim/:openingId/:clientId/back-out", async (req, res) => {
  const { openingId, clientId } = req.params as { openingId: string; clientId: string };
  try {
    const client = await getClient();
    const result = await client.workflow
      .getHandle(openingId)
      .executeUpdate<SimpleResult, [{ clientId: string }]>(backOut, { args: [{ clientId }] });
    res.json(result);
  } catch {
    res.json({ ok: false, message: "That booking isn't active." } satisfies SimpleResult);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Juniper Salon waitlist is available at http://localhost:${port}`));
