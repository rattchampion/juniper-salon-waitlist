// Shared types and the few business constants taken from the customer conversation.

export const TASK_QUEUE = "juniper-waitlist";

// How long each service takes. An opening is as long as the cancelled service.
export const SERVICE_MINUTES = { Trim: 30, Blowout: 30, Haircut: 45, Color: 120 } as const;
export type ServiceName = keyof typeof SERVICE_MINUTES;
export const SERVICE_NAMES = Object.keys(SERVICE_MINUTES) as ServiceName[];
export const STYLISTS = ["Jenna", "Priya", "Marco"] as const;

export type Daypart = "morning" | "afternoon" | "evening";
// Demo-only: lets evaluators see how a bad phone number is handled.
export type TextBehavior = "ok" | "flaky" | "fails";

// Lena: "about 15 minutes before moving on" for a same-day opening, and she
// would still offer a spot 30 minutes before the appointment. She gave no
// window for future days, so 2 hours is our assumption (flagged in the README).
export const SAME_DAY_REPLY_WINDOW_MS = 15 * 60_000;
export const FUTURE_DAY_REPLY_WINDOW_MS = 2 * 60 * 60_000;
export const DEMO_REPLY_WINDOW_MS = 20_000;
export const OFFER_CUTOFF_MS = 30 * 60_000;

export type WaitlistClient = {
  id: string;
  name: string;
  phone: string;
  service: ServiceName;
  preferredStylist: string | null; // null = any stylist
  availability: Daypart[];
  addedAt: string;
  optedOut: boolean;
  textBehavior: TextBehavior;
};

export type Appointment = {
  clientId: string;
  service: ServiceName;
  stylist: string;
  startsAt: string;
  minutes: number;
  openingId?: string; // set when this booking came from a filled opening
};

export type OpeningInfo = {
  openingId: string;
  service: ServiceName;
  stylist: string;
  startsAt: string; // ISO
  minutes: number;
};

export type OpeningInput = {
  openingId: string;
  service: ServiceName;
  stylist: string;
  startsAt: string;
  timing: "demo" | "real";
  replyWindowMs: number;
};

export type NotEligibleCode = "conflict" | "opted_out" | "too_long" | "stylist" | "availability";
export type NotEligible = { id: string; name: string; reason: string; code: NotEligibleCode };
export type PersonRef = { id: string; name: string };

export type FindNextResult = {
  next: WaitlistClient | null;
  stillEligible: PersonRef[]; // eligible, not yet contacted, excluding `next`
  notEligible: NotEligible[];
};

export type TextKind = "offer" | "confirmation" | "unavailable";

export type OutboxMessage = {
  id: string;
  at: string;
  openingId: string;
  clientId: string;
  to: string;
  name: string;
  kind: TextKind;
  body: string;
  link: string | null;
  status: "delivered" | "failed";
  attempt: number;
  error?: string;
};

export type HistoryKind =
  | "opening_created"
  | "offer_sent"
  | "text_failed"
  | "accepted"
  | "declined"
  | "timed_out"
  | "skipped"
  | "confirmed"
  | "backed_out"
  | "cancelled"
  | "unfilled"
  | "completed";

export type HistoryEntry = { at: string; kind: HistoryKind; message: string; clientId?: string };

export type OpeningStatus =
  | "searching" // choosing the next person
  | "offered" // an offer is out and we are waiting for a reply
  | "accepted" // someone has the spot
  | "completed" // the appointment time arrived with the spot filled
  | "cancelled" // staff stopped it (e.g. filled another way)
  | "unfilled"; // nobody eligible accepted, or it got too close to the time

export type OpeningView = {
  openingId: string;
  status: OpeningStatus;
  opening: OpeningInfo;
  timing: "demo" | "real";
  replyWindowMs: number;
  currentOffer: { clientId: string; name: string; sentAt: string; expiresAt: string } | null;
  acceptedBy: PersonRef | null;
  stillEligible: PersonRef[];
  notEligible: NotEligible[];
  history: HistoryEntry[];
  endedReason: string | null;
};

export type OfferReplyResult = {
  result: "accepted" | "declined" | "already_accepted" | "unavailable";
  message: string;
};
export type SimpleResult = { ok: boolean; message: string };

export const UNAVAILABLE_MESSAGE =
  "Sorry, that opening is no longer available, but we can keep you on the waitlist.";
