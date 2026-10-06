// SIMULATED integrations. In the real salon these would be:
//   waitlist.json     -> Lena's Google Sheet
//   appointments.json -> Square (confirmed appointments)
//   outbox.json       -> texts sent from the salon phone
// Each file has one writer so the Worker and API never overwrite each other.
import fs from "node:fs";
import path from "node:path";
import type { Appointment, OutboxMessage, WaitlistClient } from "./types";
import { SERVICE_MINUTES } from "./types";

const DIR = path.join(process.cwd(), ".data");

function readJson<T>(name: string, fallback: () => T): T {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    const value = fallback();
    writeJson(name, value);
    return value;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(name: string, value: unknown): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// A sensible default start time for a new opening: at least two hours away,
// on the hour or half hour. The seeded calendar conflict lines up with it.
export function defaultStart(now = new Date()): Date {
  const t = new Date(now.getTime() + 2 * 60 * 60_000);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() < 30 ? 30 : 60);
  return t;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();
}

const ALL: WaitlistClient["availability"] = ["morning", "afternoon", "evening"];

function seedWaitlist(): WaitlistClient[] {
  const c = (
    id: string,
    name: string,
    n: number,
    service: WaitlistClient["service"],
    preferredStylist: string | null,
    availability: WaitlistClient["availability"],
    extra: Partial<WaitlistClient> = {},
  ): WaitlistClient => ({
    id,
    name,
    phone: `(555) 010-${String(100 + n).padStart(4, "0")}`,
    service,
    preferredStylist,
    availability,
    addedAt: daysAgo(30 - n),
    optedOut: false,
    textBehavior: "ok",
    ...extra,
  });
  // Ordered by who joined first; Lena's rule is "earliest on the waitlist first".
  return [
    c("maya", "Maya Chen", 1, "Haircut", "Jenna", ALL),
    c("hannah", "Hannah Wu", 2, "Haircut", "Jenna", ALL),
    c("dani", "Dani Brooks", 3, "Color", "Jenna", ALL),
    c("lila", "Lila Patel", 4, "Haircut", null, ALL, { optedOut: true }),
    c("tessa", "Tessa Nguyen", 5, "Blowout", "Priya", ALL),
    c("rosa", "Rosa Martinez", 6, "Trim", null, ALL, { textBehavior: "flaky" }),
    c("marcus", "Marcus Reed", 7, "Haircut", null, ALL, { textBehavior: "fails" }),
    c("sofia", "Sofia Alvarez", 8, "Haircut", null, ALL),
    c("grace", "Grace Liu", 9, "Blowout", null, ALL),
    c("owen", "Owen Park", 10, "Haircut", "Jenna", ["afternoon", "evening"]),
    c("nina", "Nina Torres", 11, "Haircut", null, ALL),
    c("ben", "Ben Okafor", 12, "Haircut", "Jenna", ["morning"]),
  ];
}

function seedAppointments(): Appointment[] {
  // Hannah already has a blowout that overlaps the default opening time,
  // which shows the "don't offer a conflicting spot" rule.
  const start = defaultStart();
  const hannahsStart = new Date(start.getTime() - 15 * 60_000).toISOString();
  return [
    {
      clientId: "hannah",
      service: "Blowout",
      stylist: "Priya",
      startsAt: hannahsStart,
      minutes: SERVICE_MINUTES.Blowout,
    },
  ];
}

export const getWaitlist = (): WaitlistClient[] => readJson("waitlist.json", seedWaitlist);
export const getAppointments = (): Appointment[] => readJson("appointments.json", seedAppointments);
export const getOutbox = (): OutboxMessage[] => readJson("outbox.json", () => []);
export const getOpeningIds = (): string[] => readJson("openings.json", () => []);

export function appendOutbox(message: OutboxMessage): void {
  const box = getOutbox();
  box.push(message);
  writeJson("outbox.json", box);
}

export function addAppointment(appointment: Appointment): void {
  const all = getAppointments().filter(
    (a) => !(a.openingId && a.openingId === appointment.openingId),
  );
  all.push(appointment);
  writeJson("appointments.json", all);
}

export function removeAppointmentsForOpening(openingId: string): void {
  writeJson(
    "appointments.json",
    getAppointments().filter((a) => a.openingId !== openingId),
  );
}

export function registerOpening(openingId: string): void {
  const ids = getOpeningIds();
  ids.push(openingId);
  writeJson("openings.json", ids);
}

export function resetDemoData(): void {
  writeJson("waitlist.json", seedWaitlist());
  writeJson("appointments.json", seedAppointments());
  writeJson("outbox.json", []);
  writeJson("openings.json", []);
}

export function writeHeartbeat(): void {
  writeJson("heartbeat.json", { at: new Date().toISOString() });
}

export function workerIsOnline(maxAgeMs = 15_000): boolean {
  const file = path.join(DIR, "heartbeat.json");
  if (!fs.existsSync(file)) return false;
  try {
    const { at } = JSON.parse(fs.readFileSync(file, "utf8")) as { at: string };
    return Date.now() - Date.parse(at) < maxAgeMs;
  } catch {
    return false;
  }
}
