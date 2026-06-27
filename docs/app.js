// AirAware — fully client-side. Calls free, key-less, CORS-enabled APIs
// directly from the browser so the whole app can be hosted as static files.
//
// Data: Open-Meteo (air quality + geocoding) and BigDataCloud (reverse geocode).
// The risk model mirrors src/airaware/advice.py (US EPA AQI categories with a
// one-band escalation for sensitive groups).

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

const POLLUTANTS = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide", "carbon_monoxide"];

const CONCERN_REFERENCE = {
  pm2_5: 35, pm10: 150, ozone: 100,
  nitrogen_dioxide: 200, sulphur_dioxide: 100, carbon_monoxide: 10000,
};

const POLLUTANT_NAMES = {
  pm2_5: "fine particles (PM2.5) — typical of wildfire smoke",
  pm10: "coarse particles (PM10) — dust/smoke",
  ozone: "ground-level ozone (smog)",
  nitrogen_dioxide: "nitrogen dioxide (traffic pollution)",
  sulphur_dioxide: "sulfur dioxide",
  carbon_monoxide: "carbon monoxide",
};

const COUNTRY_ALIASES = {
  uk: "GB", "u.k": "GB", britain: "GB", "great britain": "GB",
  "united kingdom": "GB", england: "GB", scotland: "GB", wales: "GB",
  usa: "US", "u.s": "US", "u.s.a": "US", america: "US", "united states": "US",
  uae: "AE", holland: "NL", "south korea": "KR", "north korea": "KP",
};

const US_STATES = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
  mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
  nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina",
  nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
  tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};

// ---------- data layer ----------

class LookupError extends Error {}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function placeLabel(p) {
  const parts = [p.name];
  if (p.admin1 && p.admin1 !== p.name) parts.push(p.admin1);
  if (p.country) parts.push(p.country);
  return parts.join(", ");
}

function candidateFields(r) {
  const out = new Set();
  ["name", "admin1", "admin2", "admin3", "country", "country_code"].forEach((k) => {
    if (r[k]) out.add(String(r[k]).toLowerCase());
  });
  return out;
}

function hintScore(hint, fields, cc) {
  hint = hint.toLowerCase().trim().replace(/\.+$/, "");
  if (!hint) return 0;
  if (fields.has(hint)) return 3;
  if (COUNTRY_ALIASES[hint] && COUNTRY_ALIASES[hint].toLowerCase() === cc) return 3;
  if (US_STATES[hint] && fields.has(US_STATES[hint])) return 3;
  for (const f of fields) if (f.includes(hint)) return 1;
  return 0;
}

function bestMatch(results, hints) {
  if (!results.length) return null;
  if (!hints.length) return results[0];
  let best = null, bestKey = [-1, -1];
  for (const r of results) {
    const fields = candidateFields(r);
    const cc = String(r.country_code || "").toLowerCase();
    const score = hints.reduce((s, h) => s + hintScore(h, fields, cc), 0);
    const key = [score, r.population || 0];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = r; bestKey = key;
    }
  }
  return bestKey[0] > 0 ? best : results[0];
}

function attempts(query) {
  query = query.trim();
  if (query.includes(",")) {
    const parts = query.split(",").map((p) => p.trim()).filter(Boolean);
    return [[parts[0], parts.slice(1)]];
  }
  const toks = query.split(/\s+/);
  const out = [[query, []]];
  if (toks.length > 1) {
    out.push([toks.slice(0, -1).join(" "), [toks[toks.length - 1]]]);
    out.push([toks[0], toks.slice(1)]);
  }
  return out;
}

async function search(name) {
  const q = new URLSearchParams({ name, count: 10, language: "en", format: "json" });
  const d = await getJSON(`${GEOCODE_URL}?${q}`);
  return d.results || [];
}

async function geocode(query) {
  for (const [name, hints] of attempts(query)) {
    const results = await search(name);
    const m = bestMatch(results, hints);
    if (m) {
      return {
        name: m.name, admin1: m.admin1 || null, country: m.country_code || null,
        latitude: m.latitude, longitude: m.longitude,
      };
    }
  }
  throw new LookupError(`Couldn't find a place called “${query}”.`);
}

async function reverseGeocode(lat, lon) {
  try {
    const q = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: "en" });
    const d = await getJSON(`${REVERSE_URL}?${q}`);
    const name = d.city || d.locality || d.principalSubdivision;
    return {
      name: name || "Your location",
      admin1: d.principalSubdivision || null,
      country: d.countryCode || null,
      latitude: lat, longitude: lon,
    };
  } catch (e) {
    return { name: "Your location", admin1: null, country: null, latitude: lat, longitude: lon };
  }
}

function dominant(pollutants) {
  let best = null, bestRatio = -1;
  for (const [k, v] of Object.entries(pollutants)) {
    if (v == null) continue;
    const ratio = v / (CONCERN_REFERENCE[k] || 100);
    if (ratio > bestRatio) { bestRatio = ratio; best = k; }
  }
  return best;
}

function peakWindow(hourly) {
  const times = hourly.time || [];
  const aqis = hourly.us_aqi || [];
  let peak = -1, peakT = null;
  for (let i = 0; i < Math.min(24, times.length); i++) {
    if (aqis[i] != null && aqis[i] > peak) { peak = aqis[i]; peakT = times[i]; }
  }
  if (peakT == null || peak <= 75) return null;
  const hh = peakT.split("T").pop();
  return `around ${hh} (US AQI ~${Math.round(peak)})`;
}

async function airQuality(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon,
    current: ["us_aqi", ...POLLUTANTS].join(","),
    hourly: "us_aqi", forecast_days: 1, timezone: "auto",
  });
  const d = await getJSON(`${AIR_URL}?${q}`);
  const cur = d.current || {};
  if (cur.us_aqi == null) throw new Error("No US AQI for this location.");
  const pollutants = {};
  POLLUTANTS.forEach((k) => { if (cur[k] != null) pollutants[k] = cur[k]; });
  return {
    aqi: Math.round(cur.us_aqi),
    pollutants,
    dominant_pollutant: dominant(pollutants),
    time: cur.time || "",
    peak_window: peakWindow(d.hourly || {}),
  };
}

// ---------- advice model (mirrors advice.py) ----------

const AQI_CATEGORIES = [
  [50, "Good"], [100, "Moderate"], [150, "Unhealthy for Sensitive Groups"],
  [200, "Unhealthy"], [300, "Very Unhealthy"], [500, "Hazardous"],
];
const SENSITIVE = new Set(["respiratory", "heart", "older_adult", "pregnant", "child", "outdoor_worker"]);
const RISK_ORDER = ["none", "low", "moderate", "high", "very_high", "severe"];
const RISK_ADVICE = {
  none: ["Air quality is good.", "Enjoy normal outdoor activity.", false],
  low: ["Air quality is acceptable.", "Fine for most; if you're unusually sensitive, watch for symptoms.", false],
  moderate: ["Air quality may affect you.", "Reduce prolonged or heavy outdoor exertion; take breaks indoors.", false],
  high: ["Air quality is unhealthy for you.", "Avoid outdoor exertion. Keep windows closed; run a purifier if you have one. Wear a well-fitted N95 if you must go out.", true],
  very_high: ["Air quality is very unhealthy.", "Stay indoors with windows closed and air filtered. Avoid all outdoor exertion. Wear an N95 outdoors. Have rescue medication on hand.", true],
  severe: ["Air quality is hazardous — a health emergency.", "Stay indoors with filtered air. Do not go outside unless necessary; wear an N95 if you must. Seek medical help for any breathing difficulty.", true],
};

function category(aqi) {
  for (const [upper, label] of AQI_CATEGORIES) if (aqi <= upper) return label;
  return "Hazardous";
}

function baseRisk(aqi) {
  if (aqi <= 50) return "none";
  if (aqi <= 100) return "low";
  if (aqi <= 150) return "moderate";
  if (aqi <= 200) return "high";
  if (aqi <= 300) return "very_high";
  return "severe";
}

function personalRisk(aqi, group) {
  let level = baseRisk(aqi);
  if (SENSITIVE.has(group) && level !== "severe") {
    level = RISK_ORDER[Math.min(RISK_ORDER.indexOf(level) + 1, RISK_ORDER.length - 1)];
  }
  return level;
}

function advise(reading, group) {
  const risk = personalRisk(reading.aqi, group);
  const [headline, action, wear_mask] = RISK_ADVICE[risk];
  return {
    aqi: reading.aqi,
    category: category(reading.aqi),
    group,
    risk,
    headline,
    action,
    wear_mask,
    dominant_pollutant: reading.dominant_pollutant
      ? POLLUTANT_NAMES[reading.dominant_pollutant] || reading.dominant_pollutant
      : null,
    peak_window: reading.peak_window,
    pollutants: reading.pollutants,
    observed_at: reading.time,
  };
}

async function adviceForPlace(place, group) {
  const reading = await airQuality(place.latitude, place.longitude);
  return { ...advise(reading, group), location: placeLabel(place) };
}

// ---------- rendering ----------

const CATEGORY_ACCENT = {
  "Good": ["#2f9e6b", "rgba(47,158,107,0.13)"],
  "Moderate": ["#caa000", "rgba(217,164,0,0.15)"],
  "Unhealthy for Sensitive Groups": ["#ef8a32", "rgba(239,138,50,0.15)"],
  "Unhealthy": ["#e0524f", "rgba(224,82,79,0.14)"],
  "Very Unhealthy": ["#8a63d2", "rgba(138,99,210,0.15)"],
  "Hazardous": ["#9a4d4a", "rgba(154,77,74,0.16)"],
};

const POLLUTANT_META = {
  pm2_5: ["PM2.5", 35, "µg/m³"], pm10: ["PM10", 150, "µg/m³"], ozone: ["Ozone", 100, "µg/m³"],
  nitrogen_dioxide: ["NO₂", 200, "µg/m³"], sulphur_dioxide: ["SO₂", 100, "µg/m³"],
  carbon_monoxide: ["CO", 10000, "µg/m³"],
};

const form = document.getElementById("check-form");
const resultEl = document.getElementById("result");
const locInput = document.getElementById("location");
const groupSelect = document.getElementById("group");

function setAccent(cat) {
  const [accent, tint] = CATEGORY_ACCENT[cat] || CATEGORY_ACCENT["Good"];
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
  resultEl.innerHTML = `<div class="error-card"><h3>Hmm.</h3><p>${esc(msg)}</p></div>`;
}

function ringDash(aqi) {
  const R = 52;
  const c = 2 * Math.PI * R;
  const frac = Math.max(0.04, Math.min(1, aqi / 300));
  return { c, offset: c * (1 - frac) };
}

function groupLabel(g) {
  return ({
    general: "the general public", respiratory: "asthma / COPD", heart: "a heart condition",
    older_adult: "an older adult", pregnant: "pregnancy", child: "a child",
    outdoor_worker: "outdoor work",
  })[g] || g;
}

function pollutantBars(pollutants) {
  const rows = Object.entries(pollutants)
    .filter(([k]) => POLLUTANT_META[k])
    .map(([k, v]) => {
      const [name, ref, unit] = POLLUTANT_META[k];
      return { name, v, unit, pct: Math.max(2, Math.min(100, (v / ref) * 100)) };
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
  const { c, offset } = ringDash(d.aqi);
  const maskTag = d.wear_mask ? `<span class="tag mask">😷 Wear an N95 outdoors</span>` : "";
  const domTag = d.dominant_pollutant ? `<span class="tag"><span class="dot"></span>${esc(d.dominant_pollutant)}</span>` : "";
  const peakTag = d.peak_window ? `<span class="tag">⏱ Worst ${esc(d.peak_window)}</span>` : "";

  resultEl.innerHTML = `
    <article class="card">
      <div class="card-top">
        <div class="gauge">
          <svg viewBox="0 0 120 120">
            <circle class="track" cx="60" cy="60" r="52"></circle>
            <circle class="value" cx="60" cy="60" r="52"
              stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${c.toFixed(1)}"></circle>
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

  requestAnimationFrame(() => {
    const v = resultEl.querySelector(".gauge .value");
    if (v) v.style.strokeDashoffset = offset.toFixed(1);
  });
}

// ---------- flows ----------

async function withLoading(fn) {
  document.body.dataset.state = "loading";
  try {
    renderResult(await fn());
  } catch (e) {
    if (e instanceof LookupError) renderError(e.message);
    else renderError("Couldn't reach the air-quality service. Check your connection and try again.");
  } finally {
    document.body.dataset.state = "idle";
  }
}

function check(location, group) {
  withLoading(async () => adviceForPlace(await geocode(location), group));
}

function checkCoords(lat, lon, group) {
  withLoading(async () => adviceForPlace(await reverseGeocode(lat, lon), group));
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
      checkCoords(+pos.coords.latitude.toFixed(4), +pos.coords.longitude.toFixed(4), groupSelect.value);
      document.querySelector(".hero-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    (err) => {
      locateBtn.classList.remove("is-busy");
      locateHint.textContent = err.code === err.PERMISSION_DENIED
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
