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

// Per-group pollutant emphasis (mirrors data.GROUP_POLLUTANT_WEIGHTS). A "mild
// nudge": only re-ranks pollutants already near the raw leader, so we never hide
// a genuinely dominant pollutant just because it's off-profile for the group.
const GROUP_POLLUTANT_WEIGHTS = {
  respiratory: { ozone: 1.30, pm2_5: 1.25, nitrogen_dioxide: 1.10 },
  heart: { pm2_5: 1.30, carbon_monoxide: 1.20, nitrogen_dioxide: 1.15 },
  child: { pm2_5: 1.30, ozone: 1.20, nitrogen_dioxide: 1.15 },
  pregnant: { pm2_5: 1.30, carbon_monoxide: 1.20 },
  older_adult: { pm2_5: 1.30, ozone: 1.15 },
  outdoor_worker: { ozone: 1.30, pm2_5: 1.20 },
  general: {},
};
const NUDGE_THRESHOLD = 0.8;

// Berkeley Earth: ~22 µg/m³ PM2.5 over a day ≈ one cigarette's harm.
const CIGARETTE_PM25_PER_DAY = 22;

// Plain-language causes (mirrors advice.CAUSE_TEXT).
const CAUSE_TEXT = {
  smoke: "Fine particles (PM2.5) dominate — typically smoke from wildfires, burning, or combustion.",
  dust: "Coarse particles (PM10) dominate — often wind-blown dust or sand.",
  ozone_smog: "Ground-level ozone (smog), which builds up in hot, sunny, stagnant air.",
  traffic: "Nitrogen dioxide, mostly from traffic and combustion.",
  industrial: "Sulfur dioxide, usually from industry or burning fossil fuels.",
  combustion: "Carbon monoxide from combustion — traffic, heating, or fire.",
  mixed: "A mix of everyday urban sources.",
};

const INDOOR_PLAYBOOK = [
  "Run a HEPA purifier sized to the room (CADR near the room's area in ft²).",
  "No purifier? A box fan with a taped-on MERV-13 filter (a Corsi-Rosenthal box) works well.",
  "Pick one room to keep cleanest — close its door and run the filter there.",
  "Ventilate only when outdoor air is better than indoor; otherwise keep it sealed.",
];

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

// ---------- i18n infrastructure (mirrors nothing on the Python side — pure JS) ----------
//
// Loads language catalogs from docs/i18n/*.json (fetched once, cached in memory).
// Strings are accessed via t(path) where path is a dot-notation key, e.g.:
//   t("app.check_air")   → "Check air"
//   t("who.title")      → "Built for the people…"
//   t("app.cig_today", { n: 3 })  → "Today's air ≈ 3 cigarettes"
//
// RTL languages set dir="rtl" on <html>.

let _i18n = null;          // { lang, dir, name, app, who, how, ... }
let _i18nCatalog = null;    // raw catalog object
const _i18nCache = {};      // url → promise

async function loadI18n(lang) {
  if (_i18nCache[lang]) return _i18nCache[lang];
  _i18nCache[lang] = (async () => {
    try {
      const r = await fetch(`i18n/${lang}.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } catch {
      // Fall back to English
      try {
        const r = await fetch("i18n/en.json");
        return r.ok ? r.json() : {};
      } catch {
        return {};
      }
    }
  })();
  return _i18nCache[lang];
}

function t(key, vars) {
  if (!_i18n) return key;
  const parts = key.split(".");
  let val = _i18n;
  for (const p of parts) { val = val?.[p]; if (val === undefined) return key; }
  if (typeof val !== "string") return key;
  return vars
    ? val.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
    : val;
}

function tPlural(key, count, vars) {
  const pluralized = key.replace("_pl", count === 1 ? "" : "s");
  return t(pluralized, { ...vars, n: count });
}

async function applyI18n(lang) {
  _i18n = await loadI18n(lang);
  _i18nCatalog = _i18n;
  document.documentElement.lang = lang;
  document.documentElement.dir = _i18n.dir || "ltr";
  // Persist language choice
  try { localStorage.setItem("airaware_lang", lang); } catch (_) {}
  // Apply strings to static elements
  applyI18nToDOM(document.body);
}

function applyI18nToDOM(root) {
  if (!_i18nCatalog) return;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.placeholder = val;
    } else {
      el.textContent = val;
    }
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
}

// ---------- saved places (localStorage only — nothing leaves the browser) ----------
//
// Each saved place stores the resolved place object plus the user's group so the
// next check is instant. We use localStorage so it persists across sessions.

const SAVED_KEY = "airaware_places";
const ALERT_KEY = "airaware_alerts";

function getSavedPlaces() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); }
  catch { return []; }
}

function savePlace(place, group) {
  const places = getSavedPlaces();
  // Avoid duplicates by lat/lon
  const exists = places.some(
    (p) => p.latitude === place.latitude && p.longitude === place.longitude
  );
  if (exists) return false;
  places.unshift({ ...place, savedGroup: group, savedAt: Date.now() });
  if (places.length > 10) places.length = 10; // cap at 10
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(places)); } catch (_) {}
  return true;
}

function removeSavedPlace(latitude, longitude) {
  const places = getSavedPlaces().filter(
    (p) => !(p.latitude === latitude && p.longitude === longitude)
  );
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(places)); } catch (_) {}
}

// ---------- opt-in browser notifications (localStorage only) ----------
//
// User grants permission once; AirAware fires a notification only when a saved
// place's AQI crosses the user's threshold. Threshold defaults to "Moderate" (100).

function getAlertPrefs() {
  try { return JSON.parse(localStorage.getItem(ALERT_KEY) || "{}"); }
  catch { return {}; }
}

function setAlertPrefs(prefs) {
  try { localStorage.setItem(ALERT_KEY, JSON.stringify(prefs)); } catch (_) {}
}

function getAlertThreshold() {
  const prefs = getAlertPrefs();
  return prefs.threshold ?? 100; // default: alert when AQI > 100
}

function isAlertsEnabled() {
  return getAlertPrefs().enabled === true;
}

async function requestAlertPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

async function enableAlerts(place, group) {
  const perm = await requestAlertPermission();
  if (perm !== "granted") return perm;
  const prefs = getAlertPrefs();
  prefs.enabled = true;
  prefs.threshold = prefs.threshold ?? 100;
  // Remember this place as the alert-watch target
  prefs.watchPlace = {
    latitude: place.latitude,
    longitude: place.longitude,
    group: group,
    label: placeLabel(place),
  };
  setAlertPrefs(prefs);
  return "enabled";
}

function disableAlerts() {
  const prefs = getAlertPrefs();
  prefs.enabled = false;
  setAlertPrefs(prefs);
}

// Check if saved place AQI crosses threshold and fire one notification per
// threshold-crossing event (tracked in sessionStorage to avoid repeat noise).
async function checkAlertThreshold() {
  const prefs = getAlertPrefs();
  if (!prefs.enabled || !prefs.watchPlace) return;
  const { latitude, longitude, group, label } = prefs.watchPlace;
  try {
    const reading = await airQuality(latitude, longitude);
    const { aqi, category } = advise(reading, group);
    const threshold = prefs.threshold ?? 100;
    const sessionKey = `airaware_last_alert_${latitude}_${longitude}`;
    if (aqi <= threshold) return;
    const last = sessionStorage.getItem(sessionKey);
    const now = Date.now();
    if (last && now - +last < 3600000) return; // max 1/hr per place
    const headline = RISK_ADVICE[baseRisk(aqi)]?.[0] || "";
    new Notification(t("app.alert_notification_title"), {
      body: t("app.alert_notification_body", {
        location: label,
        aqi,
        category,
        headline,
      }),
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
    });
    sessionStorage.setItem(sessionKey, String(now));
  } catch (_) {}
}

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

// Group-aware dominant pollutant with the same mild-nudge rule as data.py.
function dominant(pollutants, group = "general") {
  const scored = [];
  for (const [k, v] of Object.entries(pollutants)) {
    if (v == null) continue;
    scored.push([v / (CONCERN_REFERENCE[k] || 100), k]);
  }
  if (!scored.length) return null;
  let rawRatio = -1, rawLeader = null;
  for (const [ratio, k] of scored) if (ratio > rawRatio) { rawRatio = ratio; rawLeader = k; }
  const weights = GROUP_POLLUTANT_WEIGHTS[group] || {};
  if (!Object.keys(weights).length || rawRatio <= 0) return rawLeader;
  let best = rawLeader, bestScore = (weights[rawLeader] || 1) * rawRatio;
  for (const [ratio, k] of scored) {
    if (ratio >= NUDGE_THRESHOLD * rawRatio) {
      const score = (weights[k] || 1) * ratio;
      if (score > bestScore) { best = k; bestScore = score; }
    }
  }
  return best;
}

function classifyCause(pollutants) {
  const dom = dominant(pollutants);
  if (dom == null) return null;
  return {
    pm2_5: "smoke", pm10: "dust", ozone: "ozone_smog",
    nitrogen_dioxide: "traffic", sulphur_dioxide: "industrial",
    carbon_monoxide: "combustion",
  }[dom] || "mixed";
}

function cigarettesEquivalent(pm25, hours = 24) {
  if (pm25 == null || pm25 < 0) return 0;
  return Math.round((pm25 / CIGARETTE_PM25_PER_DAY) * (hours / 24) * 100) / 100;
}

function hourOf(t) {
  const m = /T(\d{2}):/.exec(t);
  return m ? parseInt(m[1], 10) : -1;
}

function dayLabel(when, ref) {
  const d = new Date(when), r = new Date(ref);
  const delta = Math.round((d.setHours(0, 0, 0, 0) - r.setHours(0, 0, 0, 0)) / 86400000);
  if (delta <= 0) return "today";
  if (delta === 1) return "tomorrow";
  return new Date(when).toLocaleDateString(undefined, { weekday: "short" });
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

// Cleanest 3h waking window across the forecast, if meaningfully better than now.
function bestWindow(hourly, currentAqi) {
  const times = hourly.time || [];
  const aqis = hourly.us_aqi || [];
  let bestA = Infinity, bestT = null;
  for (let i = 0; i < times.length; i++) {
    const h = hourOf(times[i]);
    if (aqis[i] == null || h < 6 || h > 21) continue;
    if (aqis[i] < bestA) { bestA = aqis[i]; bestT = times[i]; }
  }
  if (bestT == null) return null;
  if (currentAqi != null && bestA >= currentAqi - 10) return null;
  const h = hourOf(bestT);
  const end = Math.min(h + 3, 24);
  const day = dayLabel(bestT, times[0] || bestT);
  const pad = (n) => String(n).padStart(2, "0");
  return `${day} ${pad(h)}:00–${pad(end)}:00 (US AQI ~${Math.round(bestA)})`;
}

function trend(hourly, currentAqi) {
  const aqis = (hourly.us_aqi || []).slice(0, 4).filter((a) => a != null);
  if (currentAqi == null || aqis.length < 2) return null;
  const later = aqis[aqis.length - 1];
  if (later >= currentAqi + 15) return "rising";
  if (later <= currentAqi - 15) return "falling";
  return "steady";
}

function windowAdvice(aqi, tr) {
  if (aqi <= 75) {
    if (tr === "rising") return "OK to air out now, but close up soon — air quality is worsening.";
    return "Outdoor air is clean enough — open the windows to ventilate.";
  }
  let msg = "Keep the windows closed and filter your indoor air.";
  if (tr === "falling") msg += " Air is improving — you may be able to air out later.";
  return msg;
}

async function airQuality(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon,
    current: ["us_aqi", ...POLLUTANTS].join(","),
    hourly: "us_aqi", forecast_days: 5, timezone: "auto",
  });
  const d = await getJSON(`${AIR_URL}?${q}`);
  const cur = d.current || {};
  if (cur.us_aqi == null) throw new Error("No US AQI for this location.");
  const pollutants = {};
  POLLUTANTS.forEach((k) => { if (cur[k] != null) pollutants[k] = cur[k]; });
  const aqi = Math.round(cur.us_aqi);
  const hourly = d.hourly || {};
  return {
    aqi,
    pollutants,
    dominant_pollutant: dominant(pollutants),
    time: cur.time || "",
    peak_window: peakWindow(hourly),
    best_window: bestWindow(hourly, aqi),
    cause: classifyCause(pollutants),
    cigarettes: pollutants.pm2_5 != null ? cigarettesEquivalent(pollutants.pm2_5) : null,
    trend: trend(hourly, aqi),
  };
}

// ---------- WHO context + regional indices (mirrors regional.py) ----------

const WHO_PM25_24H = 15; // µg/m³

function whoPm25Multiple(pm25) {
  if (pm25 == null || pm25 < 0) return null;
  return Math.round((pm25 / WHO_PM25_24H) * 10) / 10;
}

const EAQI_LEVELS = ["Good", "Fair", "Moderate", "Poor", "Very poor", "Extremely poor"];
const EAQI_BANDS = {
  pm2_5: [10, 20, 25, 50, 75], pm10: [20, 40, 50, 100, 150],
  nitrogen_dioxide: [40, 90, 120, 230, 340], ozone: [50, 100, 130, 240, 380],
  sulphur_dioxide: [100, 200, 350, 500, 750],
};
const DAQI_BANDS = {
  pm2_5: [11, 23, 35, 41, 47, 53, 58, 64, 70], pm10: [16, 33, 50, 58, 66, 75, 83, 91, 100],
  ozone: [33, 66, 100, 120, 140, 160, 187, 213, 240],
  nitrogen_dioxide: [67, 134, 200, 267, 334, 400, 467, 534, 600],
  sulphur_dioxide: [88, 177, 266, 354, 443, 532, 710, 887, 1064],
};
// India NAQI breakpoints: [C_lo, C_hi, I_lo, I_hi]; CO in mg/m³.
const NAQI_BP = {
  pm2_5: [[0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200], [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500]],
  pm10: [[0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200], [251, 350, 201, 300], [351, 430, 301, 400], [431, 600, 401, 500]],
  nitrogen_dioxide: [[0, 40, 0, 50], [41, 80, 51, 100], [81, 180, 101, 200], [181, 280, 201, 300], [281, 400, 301, 400], [401, 800, 401, 500]],
  ozone: [[0, 50, 0, 50], [51, 100, 51, 100], [101, 168, 101, 200], [169, 208, 201, 300], [209, 748, 301, 400], [749, 1000, 401, 500]],
  sulphur_dioxide: [[0, 40, 0, 50], [41, 80, 51, 100], [81, 380, 101, 200], [381, 800, 201, 300], [801, 1600, 301, 400], [1601, 2000, 401, 500]],
  carbon_monoxide: [[0, 1, 0, 50], [1.1, 2, 51, 100], [2.1, 10, 101, 200], [10.1, 17, 201, 300], [17.1, 34, 301, 400], [34.1, 50, 401, 500]],
};
const NAQI_CATS = [[50, "Good"], [100, "Satisfactory"], [200, "Moderate"], [300, "Poor"], [400, "Very Poor"], [500, "Severe"]];
const EU_EEA = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"]);

function bandIndex(value, uppers) {
  for (let i = 0; i < uppers.length; i++) if (value <= uppers[i]) return i + 1;
  return uppers.length + 1;
}

function worstSub(pollutants, bands) {
  let worst = 0;
  for (const k of Object.keys(bands)) {
    if (pollutants[k] == null) continue;
    worst = Math.max(worst, bandIndex(pollutants[k], bands[k]));
  }
  return worst || null;
}

function eaqi(p) {
  const lvl = worstSub(p, EAQI_BANDS);
  if (!lvl) return null;
  const label = EAQI_LEVELS[lvl - 1];
  return { system: "EU EAQI", value: label, label, scale: "Good→Extremely poor", source: "European Environment Agency" };
}

function daqiBand(i) { return i <= 3 ? "Low" : i <= 6 ? "Moderate" : i <= 9 ? "High" : "Very High"; }

function daqi(p) {
  const idx = worstSub(p, DAQI_BANDS);
  if (!idx) return null;
  return { system: "UK DAQI", value: String(idx), label: daqiBand(idx), scale: "1–10", source: "UK Defra / COMEAP" };
}

function naqiSub(c, bps) {
  for (const [clo, chi, ilo, ihi] of bps) {
    if (c >= clo && c <= chi) return ilo + ((ihi - ilo) / (chi - clo)) * (c - clo);
  }
  return c > bps[bps.length - 1][1] ? 500 : null;
}

function naqiCategory(i) { for (const [u, l] of NAQI_CATS) if (i <= u) return l; return "Severe"; }

function naqi(p) {
  let worst = null;
  for (const k of Object.keys(NAQI_BP)) {
    let v = p[k];
    if (v == null) continue;
    if (k === "carbon_monoxide") v = v / 1000;
    const s = naqiSub(v, NAQI_BP[k]);
    if (s != null) worst = Math.max(worst == null ? -1 : worst, s);
  }
  if (worst == null) return null;
  const idx = Math.round(worst);
  return { system: "India NAQI", value: String(idx), label: naqiCategory(idx), scale: "0–500", source: "India CPCB" };
}

// ---------- Canada AQHI (mirrors _aqhi in regional.py) ----------
// AQHI = (10/10.4) × 100 × [(exp(0.000537×O3_ppb)−1)+(exp(0.000871×NO2_ppb)−1)+(exp(0.000487×PM2.5)−1)]
// O3/NO2 in µg/m³ from Open-Meteo → convert to ppb (×0.70 / ×0.53).
// Factors empirically calibrated: O3×0.70, NO2×0.53 (vs live weather.gc.ca AQHI).
function aqhi(p) {
  const o3_ug  = p.ozone;
  const no2_ug = p.nitrogen_dioxide;
  const pm25   = p.pm2_5;
  const o3_ppb  = o3_ug  != null ? o3_ug  * 0.70 : null;
  const no2_ppb = no2_ug != null ? no2_ug * 0.53 : null;
  const hasO3  = o3_ppb  != null && o3_ppb  > 0;
  const hasNO2 = no2_ppb != null && no2_ppb > 0;
  const hasPM  = pm25   != null && pm25   > 0;
  if (!(hasO3 || hasNO2 || hasPM)) return null;
  const t1 = hasO3  ? (Math.exp(0.000537 * o3_ppb)  - 1) : 0;
  const t2 = hasNO2 ? (Math.exp(0.000871 * no2_ppb) - 1) : 0;
  const t3 = hasPM  ? (Math.exp(0.000487 * pm25)    - 1) : 0;
  const raw = (10 / 10.4) * 100 * (t1 + t2 + t3);
  const index = Math.max(1, Math.round(raw));
  const label = index <= 3 ? "Low" : index <= 6 ? "Moderate" : index <= 10 ? "High" : "Very High";
  return { system: "Canada AQHI", value: String(index), label, scale: "1–10+", source: "Environment and Climate Change Canada" };
}

function regionalIndex(pollutants, countryCode) {
  if (!countryCode) return null;
  const cc = countryCode.toUpperCase();
  if (cc === "GB") return daqi(pollutants);
  if (cc === "IN") return naqi(pollutants);
  if (cc === "CA") return aqhi(pollutants);
  if (EU_EEA.has(cc)) return eaqi(pollutants);
  return null;
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
  // Group-aware "main concern": the pollutant this group is most vulnerable to.
  const domKey = dominant(reading.pollutants, group);
  return {
    aqi: reading.aqi,
    category: category(reading.aqi),
    group,
    risk,
    headline,
    action,
    wear_mask,
    escalated: SENSITIVE.has(group) && risk !== baseRisk(reading.aqi),
    dominant_pollutant: domKey ? POLLUTANT_NAMES[domKey] || domKey : null,
    peak_window: reading.peak_window,
    best_window: reading.best_window,
    cause: reading.cause,
    cause_text: reading.cause ? CAUSE_TEXT[reading.cause] || null : null,
    cigarettes: reading.cigarettes,
    windows: windowAdvice(reading.aqi, reading.trend),
    pollutants: reading.pollutants,
    observed_at: reading.time,
  };
}

async function adviceForPlace(place, group) {
  const reading = await airQuality(place.latitude, place.longitude);
  return {
    ...advise(reading, group),
    location: placeLabel(place),
    who_pm25: whoPm25Multiple(reading.pollutants.pm2_5),
    regional: regionalIndex(reading.pollutants, place.country),
  };
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

// V1 atmospheric system: how thick/smoky the ambient layer feels, per category.
// Clean air → ~0 (crisp); hazardous → ~0.8 (a heavy haze creeps in at the edges).
const CATEGORY_HAZE = {
  "Good": 0, "Moderate": 0.14, "Unhealthy for Sensitive Groups": 0.28,
  "Unhealthy": 0.45, "Very Unhealthy": 0.62, "Hazardous": 0.8,
};

function setAccent(cat) {
  const [accent, tint] = CATEGORY_ACCENT[cat] || CATEGORY_ACCENT["Good"];
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-tint", tint);
  // The whole interface "breathes with the air": drive the ambient haze and a
  // category slug the background/particle layers react to.
  root.setProperty("--haze", String(CATEGORY_HAZE[cat] ?? 0));
  document.body.dataset.air = (cat || "Good").toLowerCase().replace(/[^a-z]+/g, "-");
}

// Order of US EPA categories, used to place the gauge tick along the dial.
const CATEGORY_ORDER = [
  "Good", "Moderate", "Unhealthy for Sensitive Groups",
  "Unhealthy", "Very Unhealthy", "Hazardous",
];
const CATEGORY_BOUNDS = [0, 50, 100, 150, 200, 300, 500];

// V2: angle (deg, clockwise from top) where this AQI lands on the 6-segment
// scale dial — each category occupies an equal 60° arc, interpolated within.
function gaugeTickAngle(aqi, category) {
  let i = CATEGORY_ORDER.indexOf(category);
  if (i < 0) i = 0;
  const lo = CATEGORY_BOUNDS[i];
  const hi = CATEGORY_BOUNDS[i + 1];
  const frac = Math.max(0, Math.min(1, (aqi - lo) / (hi - lo)));
  return ((i + frac) / 6) * 360;
}

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// V2: animate the big AQI number counting up from 0.
function countUp(el, target) {
  if (!el) return;
  if (prefersReducedMotion()) { el.textContent = String(target); return; }
  const dur = 900;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
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
  resultEl.innerHTML = `<div class="error-card">
    <div class="err-ico" aria-hidden="true">⚠️</div>
    <h3>Hmm, that didn't work</h3><p>${esc(msg)}</p></div>`;
}

// V2: a radial dial whose ring shows the whole Good→Hazardous scale as six
// coloured segments, with a tick marking where this reading lands.
function gaugeSvg(aqi, category) {
  const R = 52;
  const c = 2 * Math.PI * R;
  const seg = c / 6;
  const gap = 7;
  const segs = CATEGORY_ORDER.map((cat, i) => {
    const col = CATEGORY_ACCENT[cat][0];
    return `<circle class="seg" cx="60" cy="60" r="${R}" stroke="${col}"
      stroke-dasharray="${(seg - gap).toFixed(1)} ${(c - seg + gap).toFixed(1)}"
      stroke-dashoffset="${(-i * seg).toFixed(1)}"></circle>`;
  }).join("");
  const angle = gaugeTickAngle(aqi, category);
  const tick = `<line class="tick" x1="103" y1="60" x2="121" y2="60"
      transform="rotate(${angle.toFixed(1)} 60 60)"></line>`;
  return `<svg viewBox="0 0 120 120" class="dial">${segs}${tick}</svg>`;
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

// Cumulative weekly cigarette-equivalent, on-device only (nothing leaves the
// browser). Keyed by date so multiple checks in a day don't double-count.
function recordWeeklyDose(cig) {
  if (cig == null) return null;
  let store = {};
  try { store = JSON.parse(localStorage.getItem("airaware_dose") || "{}"); } catch (e) { store = {}; }
  const today = new Date().toISOString().slice(0, 10);
  store[today] = cig;
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  Object.keys(store).forEach((k) => { if (k < cutoff) delete store[k]; });
  try { localStorage.setItem("airaware_dose", JSON.stringify(store)); } catch (e) { /* private mode */ }
  const total = Object.values(store).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 10) / 10, days: Object.keys(store).length };
}

function cigaretteBlock(d) {
  if (d.cigarettes == null || d.cigarettes < 0.05) return "";
  const week = recordWeeklyDose(d.cigarettes);
  const n = d.cigarettes;
  const weekLine = week && week.days > 1
    ? `<div class="cig-week">≈ ${week.total} cigarettes over the last ${week.days} days you checked (on this device).</div>`
    : "";
  return `
    <div class="cig">
      <div class="cig-main">
        <span class="cig-ico" aria-hidden="true">🚬</span>
        <div class="cig-body">
          <div class="cig-head">Today's air ≈ <b>${n}</b> cigarette${n === 1 ? "" : "s"}</div>
          ${weekLine}
        </div>
        <button class="cig-share" type="button" aria-label="Share this as an image"
          data-cig="${n}" data-loc="${esc(d.location || "")}" data-aqi="${d.aqi}" data-cat="${esc(d.category)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 9V5l7 7-7 7v-4C7 12 5 16 4 20c0-7 3-11 10-11Z"/></svg>
          Share
        </button>
      </div>
      <details class="more">
        <summary>What does this mean?</summary>
        <p>Based on the Berkeley Earth equivalence: breathing about 22 µg/m³ of PM2.5
        for a day carries roughly the harm of one cigarette. It's a long-term
        comparison to make an invisible number feel real — not a medical figure.</p>
      </details>
    </div>`;
}

// V3: render the cigarette stat as a shareable square image (no tracking; the
// image is built locally and handed to the OS share sheet or downloaded).
function fitFont(ctx, text, weight, family, startPx, maxWidth) {
  let px = startPx;
  do {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    px -= 6;
  } while (px > 24);
  return px;
}

async function shareCigarette(btn) {
  const { cig, loc, aqi, cat } = btn.dataset;
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }
  const W = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = W;
  const ctx = canvas.getContext("2d");
  const accent = (CATEGORY_ACCENT[cat] || CATEGORY_ACCENT["Good"])[0];
  const g = ctx.createLinearGradient(0, 0, W, W);
  g.addColorStop(0, "#0b6f6b"); g.addColorStop(1, accent);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, W);
  ctx.textAlign = "center"; ctx.fillStyle = "#fff";
  const serif = "'Fraunces', Georgia, serif";
  const sans = "'Hanken Grotesk', system-ui, sans-serif";

  ctx.globalAlpha = 0.92;
  ctx.font = `600 48px ${sans}`;
  ctx.fillText("Today’s air in", W / 2, 250);
  const locPx = fitFont(ctx, loc, "700", serif, 76, W - 160);
  ctx.font = `700 ${locPx}px ${serif}`;
  ctx.fillText(loc, W / 2, 250 + locPx + 18);

  ctx.globalAlpha = 1;
  ctx.font = `700 260px ${serif}`;
  ctx.fillText(`≈ ${cig}`, W / 2, 650);
  ctx.font = `600 54px ${sans}`;
  ctx.fillText(`cigarette${cig === "1" ? "" : "s"} of harm today`, W / 2, 730);
  ctx.globalAlpha = 0.9;
  ctx.font = `500 44px ${sans}`;
  ctx.fillText(`US AQI ${aqi} · ${cat}`, W / 2, 820);

  ctx.globalAlpha = 1;
  ctx.font = `700 50px ${serif}`;
  ctx.fillText("AirAware", W / 2, 965);
  ctx.globalAlpha = 0.85;
  ctx.font = `400 33px ${sans}`;
  ctx.fillText("softbrowndog.github.io/AirAware", W / 2, 1015);

  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return;
  const file = new File([blob], "airaware.png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "AirAware",
        text: `Today’s air ≈ ${cig} cigarettes of harm.` });
      return;
    } catch (e) { /* user cancelled or unsupported — fall through to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "airaware.png"; a.click();
  URL.revokeObjectURL(url);
}

function renderResult(d) {
  setAccent(d.category);
  const maskTag = d.wear_mask ? `<span class="tag mask">😷 ${esc(t("app.mask_tag"))}</span>` : "";
  const domTag = d.dominant_pollutant ? `<span class="tag"><span class="dot"></span>${esc(d.dominant_pollutant)}</span>` : "";
  const peakTag = d.peak_window ? `<span class="tag">⏱ Worst ${esc(d.peak_window)}</span>` : "";
  const bestTag = d.best_window ? `<span class="tag good">🌿 Cleanest ${esc(d.best_window)}</span>` : "";
  const whoTag = d.who_pm25
    ? `<span class="tag">🌍 PM2.5 ${d.who_pm25}× WHO</span>` : "";
  const regionalPill = d.regional
    ? `<span class="regional-pill" title="${esc(d.regional.source)} · scale ${esc(d.regional.scale)}">${esc(d.regional.system)} ${esc(d.regional.value)} · ${esc(d.regional.label)}</span>` : "";
  const escNote = d.escalated
    ? `<span class="tuned-note">${esc(t("app.raised_for_you"))}</span>` : "";
  const obs = d.observed_at ? esc(d.observed_at.replace("T", " ")) : "—";
  const idxLine = d.regional
    ? t("app.index_regional", { system: esc(d.regional.system) })
    : t("app.index_us_aqi");
  const whyAdvice = d.escalated
    ? t("app.why_sensitive")
    : t("app.why_this_advice");
  const trustBlock = `
    <details class="trust">
      <summary>${esc(t("app.where_from"))}</summary>
      <ul>
        <li><b>${esc(t("app.observed"))}:</b> ${obs} (local time)</li>
        <li><b>${esc(t("app.data_source"))}:</b> ${esc(t("app.data_source_body"))}</li>
        <li><b>${esc(t("app.index_label"))}:</b> ${idxLine}</li>
        <li><b>${esc(t("app.why_title"))}:</b> ${whyAdvice}</li>
      </ul>
    </details>`;
  const whyBlock = d.cause_text
    ? `<p class="why"><b>${esc(t("app.why_title"))}:</b> ${esc(d.cause_text)}</p>` : "";
  const windowsBlock = d.windows
    ? `<div class="windows"><b>Indoors:</b> ${esc(d.windows)}
         <details class="more">
           <summary>${esc(t("app.indoor_title"))}</summary>
           <ul>${INDOOR_PLAYBOOK.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
         </details>
       </div>` : "";

  // Save / alerts buttons (shown only when lastPlace is available).
  const saveAlertBar = lastPlace
    ? `<div class="save-row">
         <button class="btn-save-place" type="button"
           data-lat="${lastPlace.latitude}" data-lon="${lastPlace.longitude}" data-group="${esc(d.group || "general")}">
           ${esc(t("app.save_place"))}
         </button>
         ${buildAlertUI(lastPlace, d.group || "general")}
       </div>`
    : "";

  resultEl.innerHTML = `
    <article class="card">
      ${saveAlertBar}
      <div class="card-top">
        <div class="gauge">
          ${gaugeSvg(d.aqi, d.category)}
          <div class="gauge-num"><b class="aqi-count">0</b><small>US AQI</small></div>
        </div>
        <div class="card-head">
          <h2>${esc(d.location)}</h2>
          <div class="place">${esc(t("app.tuned_for", { group: groupLabel(d.group) }))} ${escNote}</div>
          <div class="pills"><span class="category-pill">${esc(d.category)}</span>${regionalPill}</div>
        </div>
      </div>
      <div class="card-body">
        <p class="headline reveal" style="--i:0">${esc(d.headline)}</p>
        <p class="action reveal" style="--i:1">${esc(d.action)}</p>
        <div class="reveal" style="--i:2">${cigaretteBlock(d)}</div>
        <div class="reveal" style="--i:3">${whyBlock}</div>
        <div class="reveal" style="--i:4">${windowsBlock}</div>
        <div class="meta reveal" style="--i:5">${maskTag}${domTag}${peakTag}${bestTag}${whoTag}</div>
        <div class="reveal" style="--i:6">${pollutantBars(d.pollutants)}</div>
      </div>
      <div class="card-foot">
        ${trustBlock}
        <p class="foot-disc">${esc(t("app.foot_disclaimer"))}</p>
      </div>
    </article>`;

  requestAnimationFrame(() => countUp(resultEl.querySelector(".aqi-count"), d.aqi));
}

// ---------- saved-places drawer (rendered into #saved-places in index.html) ----------

function savedPlacesDrawer() {
  const places = getSavedPlaces();
  const el = document.getElementById("saved-places");
  if (!el) return;
  if (!places.length) {
    el.innerHTML = `<p class="no-places">${esc(t("app.no_saved"))}</p>`;
    return;
  }
  el.innerHTML = places.map((p) => `
    <div class="saved-item">
      <button class="saved-load" data-lat="${p.latitude}" data-lon="${p.longitude}" data-group="${esc(p.savedGroup || "general")}" type="button">
        <span class="saved-name">${esc(placeLabel(p))}</span>
        <span class="saved-group">${esc(t("app.groups." + (p.savedGroup || "general")))}</span>
      </button>
      <button class="saved-remove" data-lat="${p.latitude}" data-lon="${p.longitude}" type="button" aria-label="${esc(t("app.remove_saved"))}">×</button>
    </div>`).join("");
}

function buildAlertUI(place, group) {
  const enabled = isAlertsEnabled();
  const prefs = getAlertPrefs();
  const isThisPlace = prefs.watchPlace
    && prefs.watchPlace.latitude === place.latitude
    && prefs.watchPlace.longitude === place.longitude;
  const threshold = prefs.threshold ?? 100;
  return `
    <div class="alert-bar">
      ${enabled && isThisPlace
        ? `<span class="alert-status on">${esc(t("app.alerts_enabled"))}</span>
           <button class="alert-toggle off" type="button">${esc(t("app.disable_alerts"))}</button>`
        : `<button class="alert-toggle on" type="button">${esc(t("app.enable_alerts"))}</button>
           <label class="alert-threshold">
             <span>${esc(t("app.alert_threshold_label"))}</span>
             <select class="threshold-select" data-lat="${place.latitude}" data-lon="${place.longitude}" data-group="${esc(group)}">
               <option value="50" ${threshold == 50 ? "selected" : ""}>Good (50)</option>
               <option value="100" ${threshold == 100 ? "selected" : ""}>Moderate (100)</option>
               <option value="150" ${threshold == 150 ? "selected" : ""}>USG (150)</option>
               <option value="200" ${threshold == 200 ? "selected" : ""}>Unhealthy (200)</option>
             </select>
           </label>`
      }
    </div>`;
}

// Delegated handler for the save-place button (card is re-rendered each time).
document.addEventListener("click", (e) => {
  const saveBtn = e.target.closest(".btn-save-place");
  if (saveBtn) {
    const { lat, lon, group } = saveBtn.dataset;
    const place = { latitude: +lat, longitude: +lon };
    // Restore full place details from lastPlace if it matches
    if (lastPlace && lastPlace.latitude === +lat && lastPlace.longitude === +lon) {
      Object.assign(place, lastPlace);
    }
    const ok = savePlace(place, group);
    saveBtn.textContent = ok ? t("app.saved") : t("app.saved");
    saveBtn.disabled = !ok;
    savedPlacesDrawer();
    return;
  }
});
document.addEventListener("click", (e) => {
  const load = e.target.closest(".saved-load");
  if (load) {
    const { lat, lon, group } = load.dataset;
    groupSelect.value = group;
    checkCoords(+lat, +lon, group);
    return;
  }
  const rm = e.target.closest(".saved-remove");
  if (rm) {
    const { lat, lon } = rm.dataset;
    removeSavedPlace(+lat, +lon);
    savedPlacesDrawer();
    return;
  }
  const alertOn = e.target.closest(".alert-toggle.on");
  if (alertOn) {
    const bar = alertOn.closest(".alert-bar");
    const lat = +bar.querySelector(".threshold-select")?.dataset.lat || lastPlace?.latitude;
    const lon = +bar.querySelector(".threshold-select")?.dataset.lon || lastPlace?.longitude;
    const group = bar.querySelector(".threshold-select")?.dataset.group || groupSelect.value;
    const sel = bar.querySelector(".threshold-select");
    const threshold = sel ? +sel.value : 100;
    if (lastPlace) {
      enableAlerts(lastPlace, group).then((result) => {
        if (result === "denied") {
          bar.innerHTML = `<p class="alert-msg warn">${esc(t("app.alert_permission_denied"))}</p>`;
        } else {
          const prefs2 = getAlertPrefs();
          prefs2.threshold = threshold;
          setAlertPrefs(prefs2);
          savedPlacesDrawer(); // refresh so alert badge shows
        }
      });
    }
    return;
  }
  const alertOff = e.target.closest(".alert-toggle.off");
  if (alertOff) {
    disableAlerts();
    savedPlacesDrawer();
    return;
  }
});

document.addEventListener("change", (e) => {
  const sel = e.target.closest(".threshold-select");
  if (sel) {
    const { lat, lon, group } = sel.dataset;
    const prefs = getAlertPrefs();
    prefs.threshold = +sel.value;
    prefs.watchPlace = { latitude: +lat, longitude: +lon, group, label: placeLabel({ latitude: +lat, longitude: +lon }) };
    setAlertPrefs(prefs);
  }
});

// Language switcher: change the <select> to apply i18n.
const langSelect = document.getElementById("lang-select");
if (langSelect) {
  langSelect.addEventListener("change", () => {
    applyI18n(langSelect.value);
  });
}

// Saved-places drawer toggle (open/close via nav button).
const savedBtn = document.getElementById("saved-btn");
const savedPanel = document.getElementById("saved-places");
if (savedBtn && savedPanel) {
  savedBtn.addEventListener("click", () => {
    const open = !savedPanel.hidden;
    savedPanel.hidden = open;
    savedBtn.setAttribute("aria-expanded", String(!open));
    if (!open) savedPlacesDrawer(); // populate when opening
  });
}

// ---------- flows ----------
// V6: a shimmering skeleton of the result card while live data loads, so the
// layout settles instead of jumping in from a blank panel.
function skeleton() {
  resultEl.innerHTML = `
    <article class="card skeleton" aria-hidden="true">
      <div class="card-top">
        <div class="sk sk-gauge"></div>
        <div class="sk-head">
          <div class="sk sk-line w60"></div>
          <div class="sk sk-line w40"></div>
          <div class="sk sk-pill"></div>
        </div>
      </div>
      <div class="card-body">
        <div class="sk sk-line w80"></div>
        <div class="sk sk-line w90"></div>
        <div class="sk sk-block"></div>
        <div class="sk sk-line w70"></div>
        <div class="sk sk-bars"></div>
      </div>
    </article>`;
}

async function withLoading(fn) {
  document.body.dataset.state = "loading";
  skeleton();
  try {
    const result = await fn();
    renderResult(result);
    // After a successful check, update saved-places drawer and check alert threshold.
    savedPlacesDrawer();
    checkAlertThreshold();
  } catch (e) {
    if (e instanceof LookupError) renderError(e.message);
    else renderError(t("app.error_generic"));
  } finally {
    document.body.dataset.state = "idle";
  }
}

// Remember the last resolved place so changing "who is this for?" re-checks
// instantly without a redundant geocode.
let lastPlace = null;

function check(location, group) {
  withLoading(async () => {
    lastPlace = await geocode(location);
    return adviceForPlace(lastPlace, group);
  });
}

function checkCoords(lat, lon, group) {
  withLoading(async () => {
    lastPlace = await reverseGeocode(lat, lon);
    return adviceForPlace(lastPlace, group);
  });
}

function rerunForGroup(group) {
  if (!lastPlace) return;
  withLoading(async () => adviceForPlace(lastPlace, group));
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

// Changing "who is this for?" re-runs the last check immediately.
groupSelect.addEventListener("change", () => rerunForGroup(groupSelect.value));

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    locInput.value = chip.dataset.loc;
    groupSelect.value = chip.dataset.group;
    check(chip.dataset.loc, chip.dataset.group);
    document.querySelector(".hero-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
});

// One delegated handler for the cigarette "Share" button (the card markup is
// re-rendered on every check, so we listen on the stable container).
resultEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".cig-share");
  if (btn) shareCigarette(btn);
});

placeholder();
savedPlacesDrawer(); // populate saved-places drawer on load

// i18n: restore saved language or default to browser language.
(async () => {
  const savedLang = (() => { try { return localStorage.getItem("airaware_lang"); } catch (_) { return null; } })();
  const browserLang = navigator.language.slice(0, 2);
  const supported = ["en", "es", "hi", "id", "zh", "ar", "fr"];
  const initialLang = savedLang || (supported.includes(browserLang) ? browserLang : "en");
  await applyI18n(initialLang);
  // Sync lang-select to current language
  const sel = document.getElementById("lang-select");
  if (sel) sel.value = _i18n?.lang || "en";
  // Check alert threshold on page load (background refresh).
  checkAlertThreshold();
})();

// Register the service worker for offline/installable use. Guarded so it's a
// no-op where unsupported or when opened via file:// (e.g. standalone.html).
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
