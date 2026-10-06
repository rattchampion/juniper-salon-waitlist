// Pure rules for "can this waitlist client be offered this opening?".
// No file or network access, so it is easy to test and safe to reason about.
import type {
  Appointment,
  Daypart,
  NotEligible,
  OpeningInfo,
  WaitlistClient,
} from "./types";
import { SERVICE_MINUTES } from "./types";

export function daypartOf(iso: string): Daypart {
  const hour = new Date(iso).getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export function overlaps(aStart: string, aMinutes: number, bStart: string, bMinutes: number): boolean {
  const a0 = Date.parse(aStart);
  const a1 = a0 + aMinutes * 60_000;
  const b0 = Date.parse(bStart);
  const b1 = b0 + bMinutes * 60_000;
  return a0 < b1 && b0 < a1;
}

export type Verdict = { ok: true } | { ok: false; reason: string; code: NotEligible["code"] };

// Order matters only for which reason we show first.
export function checkClient(
  opening: OpeningInfo,
  client: WaitlistClient,
  clientAppointments: Appointment[],
): Verdict {
  if (client.optedOut) {
    return { ok: false, code: "opted_out", reason: "Asked not to be texted" };
  }
  const needed = SERVICE_MINUTES[client.service];
  if (needed > opening.minutes) {
    return {
      ok: false,
      code: "too_long",
      reason: `${client.service} takes ${needed} min; this opening is ${opening.minutes} min`,
    };
  }
  if (client.preferredStylist && client.preferredStylist !== opening.stylist) {
    return { ok: false, code: "stylist", reason: `Prefers ${client.preferredStylist}` };
  }
  if (!client.availability.includes(daypartOf(opening.startsAt))) {
    return {
      ok: false,
      code: "availability",
      reason: `Not available in the ${daypartOf(opening.startsAt)}`,
    };
  }
  const clash = clientAppointments.find(
    (appt) =>
      appt.openingId !== opening.openingId &&
      overlaps(appt.startsAt, appt.minutes, opening.startsAt, needed),
  );
  if (clash) {
    return {
      ok: false,
      code: "conflict",
      reason: `Already has a ${clash.service.toLowerCase()} appointment at that time`,
    };
  }
  return { ok: true };
}
