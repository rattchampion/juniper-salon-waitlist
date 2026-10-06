// One Workflow per open spot. It offers the spot to one eligible client at a time
// (earliest on the waitlist first), waits durably for a reply, and keeps going
// until the spot is filled, stopped by staff, or there is nobody left to ask.
// Replies arrive as Updates (applied one at a time, so two "yes" answers can
// never both win), and staff see progress through a Query.
import {
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  HistoryEntry,
  HistoryKind,
  NotEligible,
  OfferReplyResult,
  OpeningInfo,
  OpeningInput,
  OpeningStatus,
  OpeningView,
  PersonRef,
  SimpleResult,
  WaitlistClient,
} from "./types";
import { OFFER_CUTOFF_MS, SERVICE_MINUTES, UNAVAILABLE_MESSAGE } from "./types";

const { findNextEligible, bookInSquare, cancelInSquare } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

// A text that will not go through is retried a few times, then we move on.
const { sendText } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 3 },
});

export const respondToOffer = defineUpdate<
  OfferReplyResult,
  [{ clientId: string; response: "accept" | "decline" }]
>("respondToOffer");
export const backOut = defineUpdate<SimpleResult, [{ clientId: string }]>("backOut");
export const cancelOpening = defineUpdate<SimpleResult, [{ reason: string }]>("cancelOpening");
export const getOpeningView = defineQuery<OpeningView>("getOpeningView");

type Offer = {
  client: WaitlistClient;
  sentAt: string;
  expiresAt: string;
  state: "pending" | "accepted" | "declined" | "timed_out";
};

export async function fillOpeningWorkflow(input: OpeningInput): Promise<OpeningView> {
  const startMs = Date.parse(input.startsAt);
  const lastOfferMs = startMs - OFFER_CUTOFF_MS; // no new offers after this
  const opening: OpeningInfo = {
    openingId: input.openingId,
    service: input.service,
    stylist: input.stylist,
    startsAt: input.startsAt,
    minutes: SERVICE_MINUTES[input.service],
  };

  const contacted: string[] = [];
  const loggedSkips = new Set<string>();
  const history: HistoryEntry[] = [];
  let status: OpeningStatus = "searching";
  let offer = null as Offer | null;
  let acceptedBy = null as PersonRef | null;
  let acceptedClient = null as WaitlistClient | null;
  let stillEligible: PersonRef[] = [];
  let notEligible: NotEligible[] = [];
  let endedReason: string | null = null;
  let cancelReason = null as string | null;
  let backOutRequested = false as boolean;

  const log = (kind: HistoryKind, message: string, clientId?: string) =>
    history.push({ at: new Date().toISOString(), kind, message, clientId });

  const view = (): OpeningView => ({
    openingId: input.openingId,
    status,
    opening,
    timing: input.timing,
    replyWindowMs: input.replyWindowMs,
    // Only show "waiting for a reply" once the text has actually been delivered.
    currentOffer:
      offer && offer.state === "pending" && status === "offered"
        ? {
            clientId: offer.client.id,
            name: offer.client.name,
            sentAt: offer.sentAt,
            expiresAt: offer.expiresAt,
          }
        : null,
    acceptedBy,
    stillEligible,
    notEligible,
    history,
    endedReason,
  });
  setHandler(getOpeningView, view);

  // A client answers from the link in their text.
  setHandler(respondToOffer, ({ clientId, response }): OfferReplyResult => {
    if (acceptedBy?.id === clientId) {
      return { result: "already_accepted", message: "You already have this spot." };
    }
    if (offer && offer.client.id === clientId && offer.state === "pending") {
      if (response === "accept") {
        offer.state = "accepted";
        acceptedBy = { id: clientId, name: offer.client.name };
        acceptedClient = offer.client;
        status = "accepted";
        log("accepted", `${offer.client.name} accepted the spot`, clientId);
        return { result: "accepted", message: "You're booked." };
      }
      offer.state = "declined";
      log("declined", `${offer.client.name} passed on the spot`, clientId);
      return { result: "declined", message: "No problem, we'll keep you on the waitlist." };
    }
    // Late, duplicate, or for a spot that is already gone.
    return { result: "unavailable", message: UNAVAILABLE_MESSAGE };
  });

  // Someone who accepted can still change their mind.
  setHandler(backOut, ({ clientId }): SimpleResult => {
    if (acceptedBy?.id !== clientId) {
      return { ok: false, message: "That booking isn't active." };
    }
    backOutRequested = true;
    return { ok: true, message: "Okay, we've released your spot." };
  });

  // Staff stop the process, e.g. the spot was filled another way.
  setHandler(cancelOpening, ({ reason }): SimpleResult => {
    if (status === "accepted") {
      return { ok: false, message: "A client has already accepted this spot." };
    }
    if (status === "cancelled" || status === "unfilled" || status === "completed") {
      return { ok: false, message: "This opening has already finished." };
    }
    if (cancelReason === null) cancelReason = reason;
    return { ok: true, message: "Stopping. Anyone with a pending offer will be told." };
  });

  log("opening_created", `Opening created: ${opening.service} with ${opening.stylist}`);

  const finish = async (final: OpeningStatus, reason: string, kind: HistoryKind) => {
    status = final;
    endedReason = reason;
    offer = offer && offer.state === "pending" ? { ...offer, state: "timed_out" } : offer;
    log(kind, reason);
    return view();
  };

  while (true) {
    if (cancelReason !== null) {
      return finish("cancelled", `Stopped by staff: ${cancelReason}`, "cancelled");
    }
    if (Date.now() >= lastOfferMs) {
      return finish(
        "unfilled",
        "Too close to the appointment time to offer it to anyone else",
        "unfilled",
      );
    }

    const found = await findNextEligible({ opening, contactedIds: contacted });
    stillEligible = found.stillEligible;
    notEligible = found.notEligible;
    for (const skip of found.notEligible) {
      if (skip.code === "conflict" && !loggedSkips.has(skip.id)) {
        loggedSkips.add(skip.id);
        log("skipped", `Skipped ${skip.name}: ${skip.reason}`, skip.id);
      }
    }
    if (!found.next) {
      return finish("unfilled", "No one else on the waitlist fits this opening", "unfilled");
    }

    const client = found.next;
    contacted.push(client.id);
    offer = {
      client,
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + input.replyWindowMs).toISOString(),
      state: "pending",
    };

    try {
      await sendText({ openingId: input.openingId, kind: "offer", client, opening });
    } catch {
      log("text_failed", `Text to ${client.name} did not go through, moving to the next person`, client.id);
      offer = null;
      status = "searching";
      continue;
    }
    status = "offered";
    log("offer_sent", `Offer sent to ${client.name}`, client.id);

    // The reply clock starts only once the text has actually been delivered, so
    // retries on a flaky phone never eat into the client's time to answer.
    const windowMs = Math.max(0, Math.min(input.replyWindowMs, lastOfferMs - Date.now()));
    offer.sentAt = new Date().toISOString();
    offer.expiresAt = new Date(Date.now() + windowMs).toISOString();

    // Wait for a reply, a staff cancel, or the reply window to run out.
    const answered = await condition(
      () => offer?.state !== "pending" || cancelReason !== null,
      windowMs,
    );

    if (cancelReason !== null && offer?.state === "pending") {
      await notifyUnavailable(client);
      return finish("cancelled", `Stopped by staff: ${cancelReason}`, "cancelled");
    }

    if (!answered) {
      if (offer) offer.state = "timed_out";
      log("timed_out", `${client.name} didn't reply in time`, client.id);
      await notifyUnavailable(client);
      status = "searching";
      continue;
    }

    if (offer?.state === "declined") {
      status = "searching";
      continue;
    }

    if (offer?.state === "accepted" && acceptedClient) {
      await bookInSquare({ opening, client: acceptedClient });
      await sendText({ openingId: input.openingId, kind: "confirmation", client: acceptedClient, opening }).catch(
        () => log("text_failed", `Confirmation text to ${client.name} did not go through`, client.id),
      );
      log("confirmed", `${client.name} is booked`, client.id);

      // Hold the spot until the appointment, in case they change their mind.
      const held = await condition(() => backOutRequested, Math.max(0, startMs - Date.now()));
      if (!held) {
        return finish("completed", `${client.name} kept the spot`, "completed");
      }
      backOutRequested = false;
      await cancelInSquare({ openingId: input.openingId });
      log("backed_out", `${client.name} backed out, so the spot is open again`, client.id);
      acceptedBy = null;
      acceptedClient = null;
      offer = null;
      status = "searching";
    }
  }

  async function notifyUnavailable(client: WaitlistClient) {
    await sendText({ openingId: input.openingId, kind: "unavailable", client, opening }).catch(() => undefined);
  }
}
