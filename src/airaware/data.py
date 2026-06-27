"""Open-Meteo data access: geocoding + air quality. Free, no API key, global.

Stdlib-only so the whole tool runs anywhere with zero setup.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass

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
    peak_window: str | None  # "HH:MM–HH:MM" of worst AQI in next 24h, if available


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


def _dominant(pollutants: dict[str, float]) -> str | None:
    scored = [
        (v / _CONCERN_REFERENCE.get(k, 100.0), k)
        for k, v in pollutants.items()
        if v is not None
    ]
    if not scored:
        return None
    return max(scored)[1]


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


def air_quality(lat: float, lon: float) -> AirReading:
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": ",".join(["us_aqi"] + POLLUTANTS),
        "hourly": "us_aqi",
        "forecast_days": 1,
        "timezone": "auto",
    }
    data = _get(f"{AIR_URL}?{urllib.parse.urlencode(params)}")
    cur = data.get("current", {})
    pollutants = {k: cur.get(k) for k in POLLUTANTS if cur.get(k) is not None}
    aqi = cur.get("us_aqi")
    if aqi is None:
        raise RuntimeError("air-quality API returned no US AQI for this location")
    return AirReading(
        aqi=int(round(aqi)),
        pollutants=pollutants,
        dominant_pollutant=_dominant(pollutants),
        time=cur.get("time", ""),
        peak_window=_peak_window(data.get("hourly", {})),
    )
