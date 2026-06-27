"""Open-Meteo data access: geocoding + air quality. Free, no API key, global.

Stdlib-only so the whole tool runs anywhere with zero setup.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# Pollutants we request and rank to find the "dominant" concern.
POLLUTANTS = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide", "carbon_monoxide"]


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "airaware/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


@dataclass
class Place:
    name: str
    admin1: str | None
    country: str | None
    latitude: float
    longitude: float
    timezone: str | None = None

    @property
    def label(self) -> str:
        parts = [self.name]
        if self.admin1 and self.admin1 != self.name:
            parts.append(self.admin1)
        if self.country:
            parts.append(self.country)
        return ", ".join(parts)


# Common country aliases -> ISO country code, so "Salisbury, UK" or
# "...England" disambiguates correctly.
COUNTRY_ALIASES = {
    "uk": "GB", "u.k": "GB", "britain": "GB", "great britain": "GB",
    "united kingdom": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
    "usa": "US", "u.s": "US", "u.s.a": "US", "america": "US", "united states": "US",
    "uae": "AE", "holland": "NL", "south korea": "KR", "north korea": "KP",
}

# US state abbreviations -> full name (Open-Meteo returns the full admin1 name).
US_STATES = {
    "al": "alabama", "ak": "alaska", "az": "arizona", "ar": "arkansas",
    "ca": "california", "co": "colorado", "ct": "connecticut", "de": "delaware",
    "fl": "florida", "ga": "georgia", "hi": "hawaii", "id": "idaho",
    "il": "illinois", "in": "indiana", "ia": "iowa", "ks": "kansas",
    "ky": "kentucky", "la": "louisiana", "me": "maine", "md": "maryland",
    "ma": "massachusetts", "mi": "michigan", "mn": "minnesota", "ms": "mississippi",
    "mo": "missouri", "mt": "montana", "ne": "nebraska", "nv": "nevada",
    "nh": "new hampshire", "nj": "new jersey", "nm": "new mexico", "ny": "new york",
    "nc": "north carolina", "nd": "north dakota", "oh": "ohio", "ok": "oklahoma",
    "or": "oregon", "pa": "pennsylvania", "ri": "rhode island", "sc": "south carolina",
    "sd": "south dakota", "tn": "tennessee", "tx": "texas", "ut": "utah",
    "vt": "vermont", "va": "virginia", "wa": "washington", "wv": "west virginia",
    "wi": "wisconsin", "wy": "wyoming", "dc": "district of columbia",
}


def _candidate_fields(r: dict) -> set[str]:
    vals = [r.get(k) for k in ("name", "admin1", "admin2", "admin3", "country", "country_code")]
    return {str(v).lower() for v in vals if v}


def _hint_score(hint: str, fields: set[str], country_code: str) -> int:
    hint = hint.lower().strip().strip(".")
    if not hint:
        return 0
    if hint in fields:
        return 3
    cc = COUNTRY_ALIASES.get(hint)
    if cc and cc.lower() == country_code:
        return 3
    state = US_STATES.get(hint)
    if state and state in fields:
        return 3
    if any(hint in f for f in fields):
        return 1
    return 0


def _search(name: str, count: int = 10) -> list[dict]:
    q = urllib.parse.urlencode({"name": name, "count": count, "language": "en", "format": "json"})
    return _get(f"{GEOCODE_URL}?{q}").get("results") or []


def _best_match(results: list[dict], hints: list[str]) -> dict | None:
    if not results:
        return None
    if not hints:
        return results[0]  # API relevance/population order
    best, best_key = None, (-1, -1)
    for r in results:
        fields = _candidate_fields(r)
        cc = str(r.get("country_code", "")).lower()
        score = sum(_hint_score(h, fields, cc) for h in hints)
        key = (score, r.get("population") or 0)
        if key > best_key:
            best, best_key = r, key
    # If nothing matched the hints at all, fall back to the top result.
    return best if best_key[0] > 0 else results[0]


def _attempts(query: str) -> list[tuple[str, list[str]]]:
    """Turn a free-text query into (name, hints) attempts, best-guess first."""
    query = query.strip()
    if "," in query:
        parts = [p.strip() for p in query.split(",") if p.strip()]
        return [(parts[0], parts[1:])]
    toks = query.split()
    out: list[tuple[str, list[str]]] = [(query, [])]
    if len(toks) > 1:
        out.append((" ".join(toks[:-1]), [toks[-1]]))
        out.append((toks[0], toks[1:]))
    return out


def geocode(query: str) -> Place:
    """Resolve a place name to coordinates, using any region/country hint to
    disambiguate (e.g. "Salisbury, England" or "Columbus OH").

    Open-Meteo's geocoder only matches a single place token and orders results
    by relevance, which can surface the wrong "Salisbury". We parse a hint from
    the query and score candidates against it.
    """
    for name, hints in _attempts(query):
        results = _search(name)
        match = _best_match(results, hints)
        if match:
            return Place(
                name=match["name"],
                admin1=match.get("admin1"),
                country=match.get("country_code"),
                latitude=match["latitude"],
                longitude=match["longitude"],
                timezone=match.get("timezone"),
            )
    raise LookupError(f"no location found for {query!r}")


REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client"


def reverse_geocode(lat: float, lon: float) -> Place:
    """Best-effort place name for coordinates (for the 'use my location' flow).

    Falls back to a coordinate label if the reverse geocoder is unavailable.
    """
    try:
        q = urllib.parse.urlencode({"latitude": lat, "longitude": lon, "localityLanguage": "en"})
        d = _get(f"{REVERSE_URL}?{q}")
        name = d.get("city") or d.get("locality") or d.get("principalSubdivision")
        return Place(
            name=name or "Your location",
            admin1=d.get("principalSubdivision") or None,
            country=d.get("countryCode") or None,
            latitude=lat,
            longitude=lon,
        )
    except Exception:  # noqa: BLE001
        return Place(
            name="Your location",
            admin1=None,
            country=None,
            latitude=lat,
            longitude=lon,
        )


@dataclass
class AirReading:
    aqi: int
    pollutants: dict[str, float]
    dominant_pollutant: str | None
    time: str
    peak_window: str | None  # worst AQI window in next 24h, if elevated
    best_window: str | None = None  # cleanest waking window over the forecast
    cause: str | None = None  # plain-language cause key (see advice.CAUSE_TEXT)
    cigarettes: float | None = None  # daily cigarette-equivalent from PM2.5
    trend: str | None = None  # "rising" | "falling" | "steady" over next hours


# Health-relevant reference concentrations (µg/m³): roughly the level at which
# each pollutant becomes a real concern. We pick the dominant pollutant by the
# largest value-to-reference ratio, which is health-normalized rather than a
# naive comparison of raw concentrations (CO reads in the hundreds but is
# harmless at that level, so a raw comparison wrongly flags it).
_CONCERN_REFERENCE = {
    "pm2_5": 35.0,
    "pm10": 150.0,
    "ozone": 100.0,
    "nitrogen_dioxide": 200.0,
    "sulphur_dioxide": 100.0,
    "carbon_monoxide": 10000.0,
}


# Per-group pollutant emphasis. A "mild nudge": when two pollutants are close
# in health-normalized terms, prefer the one a given group is most vulnerable
# to. Weights only re-rank among pollutants already near the raw leader (see
# _NUDGE_THRESHOLD), so we never hide a genuinely dominant pollutant just
# because it's "off-profile" for the group.
GROUP_POLLUTANT_WEIGHTS = {
    "respiratory": {"ozone": 1.30, "pm2_5": 1.25, "nitrogen_dioxide": 1.10},
    "heart": {"pm2_5": 1.30, "carbon_monoxide": 1.20, "nitrogen_dioxide": 1.15},
    "child": {"pm2_5": 1.30, "ozone": 1.20, "nitrogen_dioxide": 1.15},
    "pregnant": {"pm2_5": 1.30, "carbon_monoxide": 1.20},
    "older_adult": {"pm2_5": 1.30, "ozone": 1.15},
    "outdoor_worker": {"ozone": 1.30, "pm2_5": 1.20},
    "general": {},
}

# A pollutant is only eligible to be re-ranked by group weight if its raw
# health-normalized ratio is within this fraction of the raw leader's.
_NUDGE_THRESHOLD = 0.8


def _dominant(pollutants: dict[str, float], group: str = "general") -> str | None:
    """Most health-relevant pollutant, optionally nudged toward a group's profile.

    With group="general" this is the pollutant with the largest value-to-reference
    ratio. For a sensitive group, a pollutant that group is especially vulnerable
    to can win *only if* it is already close to the raw leader (a mild nudge).
    """
    scored = [
        (v / _CONCERN_REFERENCE.get(k, 100.0), k)
        for k, v in pollutants.items()
        if v is not None
    ]
    if not scored:
        return None
    raw_ratio, raw_leader = max(scored)
    weights = GROUP_POLLUTANT_WEIGHTS.get(group) or {}
    if not weights or raw_ratio <= 0:
        return raw_leader
    best, best_score = raw_leader, weights.get(raw_leader, 1.0) * raw_ratio
    for ratio, k in scored:
        if ratio >= _NUDGE_THRESHOLD * raw_ratio:
            score = weights.get(k, 1.0) * ratio
            if score > best_score:
                best, best_score = k, score
    return best


def classify_cause(pollutants: dict[str, float]) -> str | None:
    """Plain-language cause key for today's pollution, from the pollutant mix.

    Heuristic and key-less (no external fire/weather feed). Returns a key into
    advice.CAUSE_TEXT, or None when there's nothing to explain.
    """
    dom = _dominant(pollutants)
    if dom is None:
        return None
    return {
        "pm2_5": "smoke",
        "pm10": "dust",
        "ozone": "ozone_smog",
        "nitrogen_dioxide": "traffic",
        "sulphur_dioxide": "industrial",
        "carbon_monoxide": "combustion",
    }.get(dom, "mixed")


def _peak_window(hourly: dict) -> str | None:
    times = hourly.get("time") or []
    aqis = hourly.get("us_aqi") or []
    pairs = [(a, t) for a, t in zip(aqis, times) if a is not None][:24]
    if not pairs:
        return None
    peak_aqi, peak_t = max(pairs)
    # Only flag a peak if it is meaningfully elevated.
    if peak_aqi <= 75:
        return None
    hh = peak_t.split("T")[-1]
    return f"around {hh} (US AQI ~{int(round(peak_aqi))})"


def _day_label(when: str, ref: str) -> str:
    """'today' / 'tomorrow' / weekday name for an ISO timestamp, vs a reference."""
    try:
        d = datetime.fromisoformat(when).date()
        r = datetime.fromisoformat(ref).date()
    except ValueError:
        return ""
    delta = (d - r).days
    if delta <= 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    return d.strftime("%a")


def _best_window(hourly: dict, current_aqi: int | None = None) -> str | None:
    """Cleanest 3-hour waking window across the forecast, if meaningfully better.

    Scans waking hours (06:00–21:00). Returns a one-line recommendation, or None
    when nothing is clearly cleaner than now (so we never nag pointlessly).
    """
    times = hourly.get("time") or []
    aqis = hourly.get("us_aqi") or []
    pairs = [(a, t) for a, t in zip(aqis, times) if a is not None]
    waking = [(a, t) for a, t in pairs if 6 <= _hour_of(t) <= 21]
    if not waking:
        return None
    best_aqi, best_t = min(waking, key=lambda x: x[0])
    if current_aqi is not None and best_aqi >= current_aqi - 10:
        return None
    ref = times[0] if times else best_t
    day = _day_label(best_t, ref)
    h = _hour_of(best_t)
    when = f"{day} {h:02d}:00–{min(h + 3, 24):02d}:00".strip()
    return f"{when} (US AQI ~{int(round(best_aqi))})"


def _hour_of(t: str) -> int:
    try:
        return int(t.split("T")[1].split(":")[0])
    except (IndexError, ValueError):
        return -1


def _trend(hourly: dict, current_aqi: int | None) -> str | None:
    """Short-term direction of AQI over the next few hours."""
    aqis = [a for a in (hourly.get("us_aqi") or [])[:4] if a is not None]
    if current_aqi is None or len(aqis) < 2:
        return None
    later = aqis[-1]
    if later >= current_aqi + 15:
        return "rising"
    if later <= current_aqi - 15:
        return "falling"
    return "steady"


def air_quality(lat: float, lon: float) -> AirReading:
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": ",".join(["us_aqi"] + POLLUTANTS),
        "hourly": "us_aqi",
        "forecast_days": 5,
        "timezone": "auto",
    }
    data = _get(f"{AIR_URL}?{urllib.parse.urlencode(params)}")
    cur = data.get("current", {})
    pollutants = {k: cur.get(k) for k in POLLUTANTS if cur.get(k) is not None}
    aqi = cur.get("us_aqi")
    if aqi is None:
        raise RuntimeError("air-quality API returned no US AQI for this location")
    aqi = int(round(aqi))
    hourly = data.get("hourly", {})
    pm25 = pollutants.get("pm2_5")
    return AirReading(
        aqi=aqi,
        pollutants=pollutants,
        dominant_pollutant=_dominant(pollutants),
        time=cur.get("time", ""),
        peak_window=_peak_window(hourly),
        best_window=_best_window(hourly, aqi),
        cause=classify_cause(pollutants),
        cigarettes=round(pm25 / 22.0, 2) if pm25 is not None else None,
        trend=_trend(hourly, aqi),
    )
