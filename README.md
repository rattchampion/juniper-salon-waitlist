# Juniper Salon: filling cancelled spots

A working prototype for Lena, who owns Juniper Salon. When a client cancels, staff tell the
screen about the spot, and the system texts people on the waitlist **one at a time**, keeps track
of who was asked and who answered, and tells staff clearly what is happening. It runs on
[Temporal](https://temporal.io).

## Run it (one command)

Requirements: Node.js 20+ and Docker Desktop (running).

```bash
npm install && npm run dev
```

Then open:

- **Staff screen:** <http://localhost:3000>
- **Temporal Web UI:** <http://localhost:8233>

Other commands: `npm test` (17 tests, no Docker needed), `npm run typecheck`, `npm run stop`.

## Try it in two minutes

1. On the staff screen, press **Start filling this spot** (the demo setting shortens the reply
   wait to 20 seconds so you can watch it move).
2. Maya Chen (first on the waitlist) is texted. Open the link in the **Texts sent** panel to see
   exactly what a client sees: no account, just "Yes, I'll take it" or "No thanks".
3. Do nothing and watch the offer expire. Maya is told it's gone, and the system moves on.
   Hannah is skipped (she already has an appointment then), Lila is skipped (opted out), and so on.
4. Accept as the next person. Try the link again, or open another client's link, to see that only
   one person can ever get the spot. Press **I can't make it after all** and watch it reopen.
5. Press **Spot was filled another way: stop texting** while an offer is out. The pending client is
   told, and nothing else is sent.

The waitlist panel marks a few demo phone numbers: **Rosa**'s texts fail twice and then work
(automatic retries), and **Marcus**'s never go through (the system moves on and staff see why).

## What Lena asked for, and where it lives

| What Lena said | What the prototype does |
| --- | --- |
| Someone has to keep track so spots aren't left empty | One long-running Temporal Workflow per open spot (`src/workflows.ts`) owns the whole process |
| Earliest on the waitlist first, no special priority for regulars; texting several at once "gets messy" | Offers go to one eligible person at a time, in waitlist order |
| The service must fit; stylist matters if they named one; they have general availability | Fit rules in `src/eligibility.ts` (unit tested) |
| "About 15 minutes before moving on" for same-day; no firm cutoff, would offer 30 minutes before | 15-minute reply window for same-day spots; no new offers within 30 minutes of the appointment |
| Only one person gets the spot, even if two say yes at once | Replies are Temporal **Updates**, applied one at a time inside the Workflow |
| Don't offer someone a spot that clashes with an appointment they already have | Checked against the (simulated) Square calendar before every offer |
| Clients accept with a link, no account | `public/claim.html` |
| Tell people when an offer is cancelled or times out | They get "Sorry, that opening is no longer available, but we can keep you on the waitlist." |
| A late "yes" after the spot is taken | Told it's gone and kept on the waitlist; never booked |
| Staff can stop an offer if the spot is filled another way | **Stop texting** button; the pending client is told and the process ends |
| If someone accepts, then backs out: reopen and offer to the next person | **I can't make it after all** reopens the spot; the Workflow holds the spot until the appointment |
| If a text doesn't go through, show staff and move on | Automatic retries (3 attempts), then the next person; staff see "did not go through" |
| Nobody asked twice, no one who opted out, no endless loop | Contacted people are never re-offered; opted-out clients are excluded; the process ends as **Unfilled** with a reason |
| Staff see service, stylist, time, who has the offer, status, who declined/timed out, who's still eligible | The staff screen's spot cards |
| "I'd need to know quickly when the process had stopped" | A banner appears within ~15 seconds if automatic texting stops |
| Sends on its own, no approval | No approval step |
| Warm and calm, soft neutrals with a muted green or terracotta accent | The design; message wording follows Lena's own examples |

## Why Temporal is the right tool here

- **Durable waiting.** An offer can wait 15 minutes or 2 hours for a reply. That wait is a Temporal
  timer, so it survives restarts. (Pause the Worker mid-offer and resume it: the spot picks up where
  it left off.)
- **Replies as Updates.** A client's answer is applied inside the Workflow, one at a time, which is
  what makes "only one person can get the spot" true rather than hoped for.
- **Retries.** A failing text is retried automatically; after that the Workflow decides what to do.
- **A visible history.** Every spot's story is in the Temporal Web UI; see `evidence/`.

## Simulated, and not included

**Simulated for this demo** (see `src/store.ts`): the Google Sheet waitlist, the Square calendar
(including the conflict check and booking), and the salon-phone texting. Data lives in `.data/`
and the **Reset demo data** button restores it.

**Not included:** real Square, Google Sheets, or SMS integrations; adding or editing waitlist
entries; quiet hours (Lena didn't have a rule); staff cancelling a spot *after* a client has
accepted; signed/expiring client links (the demo link is just the spot and client IDs); sign-in for staff.

## Assumptions to confirm with Lena

- A client's **named stylist is a requirement**; "any stylist" means anyone.
- **Reply window for spots on later days is 2 hours.** She only gave the 15 minutes for same-day.
- "General availability" is matched to **morning / afternoon / evening**.
- No offers in the **last 30 minutes** before the appointment.
- The reply clock starts when the text is **delivered**, not when it is first attempted.

## Project map

- `src/workflows.ts`: the Workflow, Updates, and Query
- `src/activities.ts`: finding the next person, sending texts, booking (all simulated)
- `src/eligibility.ts`: the fit rules (pure, unit tested)
- `src/store.ts`: the simulated Sheet, Square, and phone
- `src/api.ts`, `src/worker.ts`: the API and the Worker
- `public/`: staff screen (`index.html`) and the client link page (`claim.html`)
- `tests/`: unit tests plus Workflow tests that run in Temporal's time-skipping test server
- `evidence/`: Temporal Web UI screenshot of a real run
- `slides/`: the 5-slide PDF for Lena (`Juniper-Salon-Plan.pdf`) and its source
