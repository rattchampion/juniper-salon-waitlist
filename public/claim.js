// The page a client opens from the link in their text. No account needed.
const params = new URLSearchParams(location.search);
const openingId = params.get("o") ?? "";
const clientId = params.get("c") ?? "";
const base = `/api/claim/${encodeURIComponent(openingId)}/${encodeURIComponent(clientId)}`;
const card = document.querySelector("#card");

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function when(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const day =
    d.toDateString() === today.toDateString()
      ? "today"
      : d.toDateString() === tomorrow.toDateString()
        ? "tomorrow"
        : d.toLocaleDateString([], { weekday: "long" });
  return `${day} at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

let busy = false;
const unavailable = (message) => `
  <h1>This opening is no longer available</h1>
  <p class="big">${esc(message)}</p>
  <p class="small">Thanks for your quick reply. We'll text you when something else opens up.</p>`;

function render(view) {
  if (view.state === "offer") {
    card.innerHTML = `
      <h1>Hi ${esc(view.firstName)}, a spot opened up</h1>
      <p class="big">${esc(view.service)} ${esc(when(view.startsAt))} with ${esc(view.stylist)}</p>
      <p class="small">Would you like it?</p>
      <div class="row">
        <button id="accept">Yes, I'll take it</button>
        <button id="decline" class="quiet">No thanks</button>
      </div>
      <p class="small" id="expires"></p>`;
    document.querySelector("#accept").onclick = () => respond("accept");
    document.querySelector("#decline").onclick = () => respond("decline");
    updateExpiry(view.expiresAt);
  } else if (view.state === "accepted") {
    card.innerHTML = `
      <h1>You're booked</h1>
      <p class="big">${esc(view.service)} ${esc(when(view.startsAt))} with ${esc(view.stylist)}</p>
      <p class="small">Please call us if your plans change.</p>
      <div class="row"><button id="back-out" class="quiet">I can't make it after all</button></div>`;
    document.querySelector("#back-out").onclick = backOut;
  } else if (view.state === "declined") {
    card.innerHTML = `<h1>No problem</h1><p class="big">We'll keep you on the waitlist.</p>`;
  } else {
    card.innerHTML = unavailable(view.message ?? "Sorry, that opening is no longer available, but we can keep you on the waitlist.");
  }
}

let expiry = null;
function updateExpiry(iso) {
  expiry = iso;
}
setInterval(() => {
  const el = document.querySelector("#expires");
  if (!el || !expiry) return;
  const left = Math.max(0, Math.round((Date.parse(expiry) - Date.now()) / 1000));
  const text =
    left >= 3600
      ? `${Math.floor(left / 3600)} hr ${Math.floor((left % 3600) / 60)} min`
      : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  el.textContent = left > 0 ? `This offer is open for ${text} more.` : "";
}, 1000);

async function respond(response) {
  if (busy) return;
  busy = true;
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const result = await (
    await fetch(`${base}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    })
  ).json();
  busy = false;
  await load(result.result === "unavailable" ? result.message : undefined);
}

async function backOut() {
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  await fetch(`${base}/back-out`, { method: "POST" });
  card.innerHTML = `<h1>Okay, we've released your spot</h1><p class="big">We'll keep you on the waitlist.</p>`;
}

async function load(message) {
  const view = await (await fetch(base)).json();
  if (message && view.state !== "accepted") view.message = message;
  render(view);
}

load();
setInterval(() => {
  if (!busy && document.querySelector("#decline")) load();
}, 3000);
