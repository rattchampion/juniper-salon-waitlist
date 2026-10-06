import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClient } from "../src/eligibility";
import type { Appointment, OpeningInfo, WaitlistClient } from "../src/types";

// 3:00 PM local time, Haircut (45 min) with Jenna.
const startsAt = new Date(2030, 0, 15, 15, 0).toISOString();
const opening: OpeningInfo = { openingId: "o1", service: "Haircut", stylist: "Jenna", startsAt, minutes: 45 };

const client = (over: Partial<WaitlistClient> = {}): WaitlistClient => ({
  id: "c1",
  name: "Test Client",
  phone: "(555) 010-0001",
  service: "Haircut",
  preferredStylist: null,
  availability: ["morning", "afternoon", "evening"],
  addedAt: "2030-01-01T00:00:00Z",
  optedOut: false,
  textBehavior: "ok",
  ...over,
});

test("someone who fits is eligible", () => {
  assert.equal(checkClient(opening, client(), []).ok, true);
});

test("a long service cannot take a short opening", () => {
  const verdict = checkClient(opening, client({ service: "Color" }), []);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.code, "too_long");
});

test("a shorter service can take a longer opening", () => {
  assert.equal(checkClient(opening, client({ service: "Trim" }), []).ok, true);
});

test("a stated stylist preference must match, but no preference is fine", () => {
  assert.equal(checkClient(opening, client({ preferredStylist: "Priya" }), []).ok, false);
  assert.equal(checkClient(opening, client({ preferredStylist: "Jenna" }), []).ok, true);
  assert.equal(checkClient(opening, client({ preferredStylist: null }), []).ok, true);
});

test("availability must include the time of day", () => {
  const verdict = checkClient(opening, client({ availability: ["morning"] }), []);
  assert.equal(!verdict.ok && verdict.code, "availability");
});

test("an overlapping appointment blocks the offer", () => {
  const clash: Appointment = {
    clientId: "c1",
    service: "Blowout",
    stylist: "Priya",
    startsAt: new Date(2030, 0, 15, 14, 45).toISOString(),
    minutes: 30,
  };
  const verdict = checkClient(opening, client(), [clash]);
  assert.equal(!verdict.ok && verdict.code, "conflict");
});

test("an appointment that ends exactly when the opening starts is not a conflict", () => {
  const before: Appointment = {
    clientId: "c1",
    service: "Blowout",
    stylist: "Priya",
    startsAt: new Date(2030, 0, 15, 14, 30).toISOString(),
    minutes: 30,
  };
  assert.equal(checkClient(opening, client(), [before]).ok, true);
});

test("clients who opted out are never eligible", () => {
  const verdict = checkClient(opening, client({ optedOut: true }), []);
  assert.equal(!verdict.ok && verdict.code, "opted_out");
});
