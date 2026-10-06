# Evidence

`temporal-workflow-opening-da6cb8b8.png` is the Temporal Web UI (localhost:8233) showing one
real run of `fillOpeningWorkflow` (Workflow ID `opening-da6cb8b8`, a Haircut with Jenna).
Reading the event history from the bottom up:

- **Workflow Execution Update Accepted / Completed (`respondToOffer`)**: the client tapped
  "Yes" on the link in her text. The Update returned `accepted`, and because Updates run one
  at a time inside the Workflow, a second simultaneous "yes" can never also win.
- **Timer Canceled**: the 2-hour reply window was durably cancelled because she answered.
- **Activity `bookInSquare`** then **Activity `sendText`** (`{"delivered":true}`): the booking
  was recorded and her confirmation text went out.
- **Timer Started (2 hours, 22 minutes)**: the Workflow keeps holding the spot until the
  appointment time, so it can reopen the spot if she backs out.

All names and phone numbers in the demo are made up.
