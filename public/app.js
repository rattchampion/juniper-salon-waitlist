const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const timeSec = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long" });
}
const toLocalInput = (iso) => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
// 90 seconds -> "1:30"; 2 hours -> "2 hr"; keeps long windows readable.
function countdown(seconds) {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
const linkify = (text) =>
  esc(text).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return response.json();
}

// ---- Form ------------------------------------------------------------------

async function setupForm() {
  const defaults = await api("/api/defaults");
  $("#service").innerHTML = defaults.services
    .map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.minutes} min)</option>`)
    .join("");
  $("#service").value = "Haircut";
  $("#stylist").innerHTML = defaults.stylists.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#startsAt").value = toLocalInput(defaults.startsAt);
}

$("#new-spot").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#form-error");
  error.hidden = true;
  $("#start").disabled = true;
  const result = await api("/api/openings", {
    method: "POST",
    body: JSON.stringify({
      service: $("#service").value,
      stylist: $("#stylist").value,
      startsAt: new Date($("#startsAt").value).toISOString(),
      timing: $("#timing").value,
    }),
  });
  $("#start").disabled = false;
  if (result.error) {
    error.textContent = result.error;
    error.hidden = false;
    return;
  }
  refresh();
});

// ---- Open spots --------------------------------------------------------------

const openDetails = new Set();
document.addEventListener(
  "toggle",
  (event) => {
    const id = event.target.dataset?.id;
    if (!id) return;
    if (event.target.open) openDetails.add(id);
    else openDetails.delete(id);
  },
  true,
);

function statusChip(view) {
  const offer = view.currentOffer;
  switch (view.status) {
    case "offered":
      return `<span class="chip waiting">Waiting for ${esc(offer?.name)} · <span data-expires="${esc(offer?.expiresAt)}"></span></span>`;
    case "searching":
      return `<span class="chip waiting">Finding the next person…</span>`;
    case "accepted":
      return `<span class="chip good">Booked: ${esc(view.acceptedBy?.name)}</span>`;
    case "completed":
      return `<span class="chip good">Filled: ${esc(view.acceptedBy?.name)}</span>`;
    case "cancelled":
      return `<span class="chip neutral">Stopped</span>`;
    default:
      return `<span class="chip warn">Unfilled</span>`;
  }
}

function spotCard({ id, view }) {
  if (!view) {
    return `<div class="spot"><div class="spot-title">${esc(id)}</div>
      <p class="spot-sub">Can't read this spot right now. Automatic texting may have stopped.</p></div>`;
  }
  const o = view.opening;
  const active = view.status === "offered" || view.status === "searching";
  const history = [...view.history]
    .reverse()
    .map((h) => `<li><span class="when">${esc(timeSec(h.at))}</span><span>${esc(h.message)}</span></li>`)
    .join("");
  const eligible = view.stillEligible.length
    ? view.stillEligible.map((p) => esc(p.name)).join(", ")
    : "No one else waiting in line";
  const notFit = view.notEligible.length
    ? `<ul class="plain">${view.notEligible
        .map((p) => `<li><strong>${esc(p.name)}</strong>: ${esc(p.reason)}</li>`)
        .join("")}</ul>`
    : `<p class="empty">Everyone fits.</p>`;
  return `
    <div class="spot">
      <div class="spot-head">
        <div>
          <div class="spot-title">${esc(o.service)} with ${esc(o.stylist)}</div>
          <div class="spot-sub">${esc(dayLabel(o.startsAt))}, ${esc(time(o.startsAt))} · ${o.minutes} minutes</div>
        </div>
        ${statusChip(view)}
      </div>
      ${view.endedReason ? `<p class="hint">${esc(view.endedReason)}</p>` : ""}
      <div class="cols">
        <div>
          <h3>Who has been asked</h3>
          <ul class="plain timeline">${history}</ul>
        </div>
        <div>
          <h3>Still eligible, in order</h3>
          <p>${eligible}</p>
          <h3 style="margin-top: 14px">Not a fit for this spot</h3>
          ${notFit}
        </div>
      </div>
      ${active ? `<div class="actions"><button class="secondary" data-stop="${esc(id)}">Spot was filled another way: stop texting</button></div>` : ""}
    </div>`;
}

async function refreshSpots() {
  const { openings } = await api("/api/openings");
  if (!openings.length) {
    $("#spots").innerHTML = `<p class="empty">Nothing yet. Start a spot above.</p>`;
    return;
  }
  $("#spots").innerHTML = openings.map(spotCard).join("");
  tick();
}

document.addEventListener("click", async (event) => {
  const stop = event.target.closest("[data-stop]");
  if (!stop) return;
  if (!confirm("Stop texting for this spot? Anyone with a pending offer will be told it's no longer available.")) return;
  stop.disabled = true;
  await api(`/api/openings/${encodeURIComponent(stop.dataset.stop)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "filled another way" }),
  });
  refresh();
});

function tick() {
  document.querySelectorAll("[data-expires]").forEach((el) => {
    const left = Math.max(0, Math.round((Date.parse(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = left > 0 ? `${countdown(left)} left` : "time's up";
  });
}
setInterval(tick, 1000);

// ---- Texts, waitlist, health -------------------------------------------------

const kindLabel = { offer: "Offer", confirmation: "Confirmation", unavailable: "No longer available" };

async function refreshTexts() {
  const { outbox } = await api("/api/outbox");
  $("#texts").innerHTML = outbox.length
    ? outbox
        .map(
          (m) => `<div class="text-msg ${m.status === "failed" ? "failed" : ""}">
            <div class="text-meta">${esc(timeSec(m.at))} · To ${esc(m.name)} ${esc(m.to)} · ${esc(kindLabel[m.kind])}
              ${m.status === "failed" ? ` · <strong>did not go through (attempt ${m.attempt}): ${esc(m.error)}</strong>` : ""}</div>
            ${linkify(m.body)}${m.link ? "" : ""}
          </div>`,
        )
        .join("")
    : `<p class="empty">No texts yet.</p>`;
}

async function refreshWaitlist() {
  const { waitlist } = await api("/api/waitlist");
  $("#waitlist").innerHTML = waitlist
    .map((c, i) => {
      const notes = [
        c.optedOut ? '<span class="tag">asked not to be texted</span>' : "",
        c.textBehavior === "flaky" ? '<span class="tag">demo: first texts fail, then work</span>' : "",
        c.textBehavior === "fails" ? '<span class="tag">demo: texts never go through</span>' : "",
      ].join("");
      return `<tr><td>${i + 1}</td><td>${esc(c.name)}</td><td>${esc(c.service)}</td>
        <td>${esc(c.preferredStylist ?? "Any")}</td><td>${esc(c.availability.join(", "))}</td><td>${notes}</td></tr>`;
    })
    .join("");
}

async function refreshHealth() {
  const health = await api("/api/health");
  const banner = $("#banner");
  if (!health.temporal) {
    banner.hidden = false;
    banner.textContent =
      "We can't reach the scheduling system, so nobody is being texted right now. Use your Google Sheet and the salon phone until this is fixed.";
  } else if (!health.worker) {
    banner.hidden = false;
    banner.textContent =
      "Automatic texting has stopped. Nobody is being texted right now. Use your Google Sheet and the salon phone until this is fixed. Spots already started will pick up where they left off once it's back.";
  } else {
    banner.hidden = true;
  }
}

$("#reset").addEventListener("click", async () => {
  if (!confirm("Reset the demo waitlist, calendar, and texts?")) return;
  await api("/api/reset-demo", { method: "POST" });
  await Promise.all([setupForm(), refresh(), refreshWaitlist()]);
});

async function refresh() {
  await Promise.all([refreshSpots(), refreshTexts(), refreshHealth()]);
}

setupForm();
refreshWaitlist();
refresh();
setInterval(refresh, 2000);
