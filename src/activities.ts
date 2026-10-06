// Activities do the real-world work: look people up, send texts, book appointments.
// Everything here is SIMULATED (see store.ts) except the retry behaviour, which
// is real Temporal. Workflows stay deterministic; activities may fail and retry.
import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { checkClient } from "./eligibility";
import {
  addAppointment,
  appendOutbox,
  getAppointments,
  getWaitlist,
  removeAppointmentsForOpening,
} from "./store";
import type {
  FindNextResult,
  NotEligible,
  OpeningInfo,
  PersonRef,
  TextKind,
  WaitlistClient,
} from "./types";
import { SERVICE_MINUTES, UNAVAILABLE_MESSAGE } from "./types";

export async function findNextEligible(args: {
  opening: OpeningInfo;
  contactedIds: string[];
}): Promise<FindNextResult> {
  const contacted = new Set(args.contactedIds);
  const appointments = getAppointments();
  const eligible: WaitlistClient[] = [];
  const notEligible: NotEligible[] = [];

  // Earliest on the waitlist goes first; no special priority for regulars.
  const waitlist = [...getWaitlist()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  for (const client of waitlist) {
    if (contacted.has(client.id)) continue; // never offer the same opening twice
    const mine = appointments.filter((a) => a.clientId === client.id);
    const verdict = checkClient(args.opening, client, mine);
    if (verdict.ok) eligible.push(client);
    else notEligible.push({ id: client.id, name: client.name, reason: verdict.reason, code: verdict.code });
  }
  const [next, ...rest] = eligible;
  const stillEligible: PersonRef[] = rest.map((c) => ({ id: c.id, name: c.name }));
  return { next: next ?? null, stillEligible, notEligible };
}

function dayWord(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
  if (d.toDateString() === today.toDateString()) return "today";
  if (d.toDateString() === tomorrow.toDateString()) return "tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "long" });
}

function timeWord(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Wording follows Lena's own examples: first names, no emojis, no sign-off.
function compose(kind: TextKind, client: WaitlistClient, opening: OpeningInfo, link: string): string {
  const first = client.name.split(" ")[0];
  const when = `${dayWord(opening.startsAt)} at ${timeWord(opening.startsAt)} with ${opening.stylist}`;
  if (kind === "offer") {
    return `Hi ${first}, we have an opening for a ${client.service.toLowerCase()} ${when}. Claim it or pass here: ${link}`;
  }
  if (kind === "confirmation") {
    return `You're booked for ${when}. Please call us if your plans change.`;
  }
  return UNAVAILABLE_MESSAGE;
}

export async function sendText(args: {
  openingId: string;
  kind: TextKind;
  client: WaitlistClient;
  opening: OpeningInfo;
}): Promise<{ delivered: true }> {
  const attempt = Context.current().info.attempt;
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const link =
    args.kind === "offer"
      ? `${base}/claim.html?o=${encodeURIComponent(args.openingId)}&c=${encodeURIComponent(args.client.id)}`
      : null;
  const body = compose(args.kind, args.client, args.opening, link ?? "");
  const record = (status: "delivered" | "failed", error?: string) =>
    appendOutbox({
      id: randomUUID(),
      at: new Date().toISOString(),
      openingId: args.openingId,
      clientId: args.client.id,
      to: args.client.phone,
      name: args.client.name,
      kind: args.kind,
      body,
      link,
      status,
      attempt,
      error,
    });

  // Simulated carrier problems so retries and failures can be demonstrated.
  const behavior = args.client.textBehavior;
  if (behavior === "fails" || (behavior === "flaky" && attempt < 3)) {
    const error = "The phone carrier did not accept the message";
    record("failed", error);
    throw new Error(error);
  }
  record("delivered");
  return { delivered: true };
}

// Stand-ins for writing to Square once a client accepts or backs out.
export async function bookInSquare(args: {
  opening: OpeningInfo;
  client: WaitlistClient;
}): Promise<void> {
  addAppointment({
    clientId: args.client.id,
    service: args.client.service,
    stylist: args.opening.stylist,
    startsAt: args.opening.startsAt,
    minutes: SERVICE_MINUTES[args.client.service],
    openingId: args.opening.openingId,
  });
}

export async function cancelInSquare(args: { openingId: string }): Promise<void> {
  removeAppointmentsForOpening(args.openingId);
}
