// AirAware front-end: fetch personalized advice and render an adaptive card.

const CATEGORY_ACCENT = {
  "Good": ["#2f9e6b", "rgba(47,158,107,0.13)"],
  "Moderate": ["#caa000", "rgba(217,164,0,0.15)"],
  "Unhealthy for Sensitive Groups": ["#ef8a32", "rgba(239,138,50,0.15)"],
  "Unhealthy": ["#e0524f", "rgba(224,82,79,0.14)"],
  "Very Unhealthy": ["#8a63d2", "rgba(138,99,210,0.15)"],
  "Hazardous": ["#9a4d4a", "rgba(154,77,74,0.16)"],
};

const POLLUTANT_META = {
  pm2_5: ["PM2.5", 35, "µg/m³"],
  pm10: ["PM10", 150, "µg/m³"],
  ozone: ["Ozone", 100, "µg/m³"],
  nitrogen_dioxide: ["NO₂", 200, "µg/m³"],
  sulphur_dioxide: ["SO₂", 100, "µg/m³"],
  carbon_monoxide: ["CO", 10000, "µg/m³"],
};

const form = document.getElementById("check-form");
const resultEl = document.getElementById("result");
const locInput = document.getElementById("location");
const groupSelect = document.getElementById("group");

function setAccent(category) {
  const [accent, tint] = CATEGORY_ACCENT[category] || CATEGORY_ACCENT["Good"];
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--accent-tint", tint);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function placeholder() {
  resultEl.innerHTML = `
    <div class="result-placeholder">
      <div class="ph-ring"></div>
      <h3>Your air report appears here</h3>
      <p>Enter a location and choose who it's for. We'll read the live air and tell you what to do.</p>
    </div>`;
}

function renderError(msg) {
  resultEl.innerHTML = `
    <div class="error-card">
      <h3>Hmm.</h3>
      <p>${esc(msg)}</p>
    </div>`;
}

function ringDash(aqi) {
  // Map AQI (0–300+) onto the arc; clamp so extreme values still read full.
  const R = 52;
  const circumference = 2 * Math.PI * R;
  const frac = Math.max(0.04, Math.min(1, aqi / 300));
  return { circumference, offset: circumference * (1 - frac) };
}

function pollutantBars(pollutants) {
  const rows = Object.entries(pollutants)
    .filter(([k]) => POLLUTANT_META[k])
    .map(([k, v]) => {
      const [name, ref, unit] = POLLUTANT_META[k];
      const pct = Math.max(2, Math.min(100, (v / ref) * 100));
      return { name, v, unit, pct };
    })
    .sort((a, b) => b.pct - a.pct);
  if (!rows.length) return "";
  return `
    <div class="bars-title">Pollutants (share of their concern level)</div>
    <div class="bars">
      ${rows.map((r) => `
        <div class="bar-row">
          <span class="name">${esc(r.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${r.pct.toFixed(0)}%"></span></span>
          <span class="val">${r.v}<span style="opacity:.6"> ${esc(r.unit)}</span></span>
        </div>`).join("")}
    </div>`;
}

function renderResult(d) {
  setAccent(d.category);
  const { circumference, offset } = ringDash(d.aqi);
  const maskTag = d.wear_mask
    ? `<span class="tag mask">😷 Wear an N95 outdoors</span>` : "";
  const domTag = d.dominant_pollutant
    ? `<span class="tag"><span class="dot"></span>${esc(d.dominant_pollutant)}</span>` : "";
  const peakTag = d.peak_window
    ? `<span class="tag">⏱ Worst ${esc(d.peak_window)}</span>` : "";

  resultEl.innerHTML = `
    <article class="card">
      <div class="card-top">
        <div class="gauge">
          <svg viewBox="0 0 120 120">
            <circle class="track" cx="60" cy="60" r="52"></circle>
            <circle class="value" cx="60" cy="60" r="52"
              stroke-dasharray="${circumference.toFixed(1)}"
              stroke-dashoffset="${circumference.toFixed(1)}"></circle>
          </svg>
          <div class="gauge-num"><b>${d.aqi}</b><small>US AQI</small></div>
        </div>
        <div class="card-head">
          <h2>${esc(d.location)}</h2>
          <div class="place">Air report · for ${esc(groupLabel(d.group))}</div>
          <span class="category-pill">${esc(d.category)}</span>
        </div>
      </div>
      <div class="card-body">
        <p class="headline">${esc(d.headline)}</p>
        <p class="action">${esc(d.action)}</p>
        <div class="meta">${maskTag}${domTag}${peakTag}</div>
        ${pollutantBars(d.pollutants)}
      </div>
      <div class="card-foot">Live reading${d.observed_at ? " · " + esc(d.observed_at.replace("T", " ")) : ""} · informational, not medical advice.</div>
    </article>`;

  // Animate the ring after paint (bars get their width inline, then ease via CSS).
  requestAnimationFrame(() => {
    const v = resultEl.querySelector(".gauge .value");
    if (v) v.style.strokeDashoffset = offset.toFixed(1);
  });
}

function groupLabel(g) {
  return ({
    general: "the general public",
    respiratory: "asthma / COPD",
    heart: "a heart condition",
    older_adult: "an older adult",
    pregnant: "pregnancy",
    child: "a child",
    outdoor_worker: "outdoor work",
  })[g] || g;
}

async function fetchAdvice(params) {
  document.body.dataset.state = "loading";
  try {
    const res = await fetch(`/api/advice?${params}`);
    const data = await res.json();
    if (!res.ok) { renderError(data.error || "Something went wrong."); return; }
    renderResult(data);
  } catch (e) {
    renderError("Couldn't reach the server. Check your connection and try again.");
  } finally {
    document.body.dataset.state = "idle";
  }
}

function check(location, group) {
  fetchAdvice(`location=${encodeURIComponent(location)}&group=${encodeURIComponent(group)}`);
}

function checkCoords(lat, lon, group) {
  fetchAdvice(`lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&group=${encodeURIComponent(group)}`);
}

const locateBtn = document.getElementById("locate");
const locateHint = document.getElementById("locate-hint");

function useMyLocation() {
  if (!("geolocation" in navigator)) {
    locateHint.textContent = "Geolocation isn't supported on this device.";
    return;
  }
  locateBtn.classList.add("is-busy");
  locateHint.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locateBtn.classList.remove("is-busy");
      locateHint.textContent = "";
      checkCoords(pos.coords.latitude.toFixed(4), pos.coords.longitude.toFixed(4), groupSelect.value);
      document.querySelector(".hero-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    (err) => {
      locateBtn.classList.remove("is-busy");
      locateHint.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Location permission denied — type a place instead."
          : "Couldn't get your location — type a place instead.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
}

locateBtn.addEventListener("click", useMyLocation);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const loc = locInput.value.trim();
  if (!loc) { locInput.focus(); return; }
  check(loc, groupSelect.value);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    locInput.value = chip.dataset.loc;
    groupSelect.value = chip.dataset.group;
    check(chip.dataset.loc, chip.dataset.group);
    document.querySelector(".hero-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
});

placeholder();
