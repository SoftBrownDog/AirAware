"""WHO-guideline context and locale-aware regional air-quality indices.

US AQI stays the primary, globally-consistent number AirAware reports. On top of
it we add two credibility layers that matter for an international audience:

* a WHO-guideline "× over guideline" context line (universal), and
* the user's *own* national index when we have one for their country — EU EAQI,
  UK DAQI, or India NAQI — shown as a secondary, familiar reading.

Pure logic, stdlib-only, and mirrored verbatim in docs/app.js (parity is part of
the trust story). All breakpoint tables are documented inline.
"""

from __future__ import annotations

from dataclasses import dataclass

# WHO 2021 Air Quality Guidelines, 24-hour levels (µg/m³; CO is 24-h in mg/m³ →
# 4000 µg/m³). The PM2.5 multiple is the headline credibility figure.
WHO_GUIDELINES = {
    "pm2_5": 15.0,
    "pm10": 45.0,
    "ozone": 100.0,
    "nitrogen_dioxide": 25.0,
    "sulphur_dioxide": 40.0,
    "carbon_monoxide": 4000.0,
}


def who_pm25_multiple(pm25: float | None) -> float | None:
    """How many times the WHO 24-hour PM2.5 guideline (15 µg/m³) the air is."""
    if pm25 is None or pm25 < 0:
        return None
    return round(pm25 / WHO_GUIDELINES["pm2_5"], 1)


@dataclass
class RegionalIndex:
    system: str       # e.g. "UK DAQI"
    value: str        # display value, e.g. "7" or "Poor"
    label: str        # band name, e.g. "High"
    scale: str        # human scale hint, e.g. "1–10"
    source: str       # attribution / authority


# ---------------------------------------------------------------------------
# EU — European Air Quality Index (EAQI). Overall index is the worst pollutant
# sub-index. Bands are upper bounds (µg/m³); above the last bound → level 6.
# Levels: 1 Good, 2 Fair, 3 Moderate, 4 Poor, 5 Very poor, 6 Extremely poor.
# ---------------------------------------------------------------------------
_EAQI_LEVELS = ["Good", "Fair", "Moderate", "Poor", "Very poor", "Extremely poor"]
_EAQI_BANDS = {
    "pm2_5": [10, 20, 25, 50, 75],
    "pm10": [20, 40, 50, 100, 150],
    "nitrogen_dioxide": [40, 90, 120, 230, 340],
    "ozone": [50, 100, 130, 240, 380],
    "sulphur_dioxide": [100, 200, 350, 500, 750],
}


def _band_index(value: float, uppers: list[float]) -> int:
    """1-based band for `value` given ascending upper bounds (len+1 if above)."""
    for i, hi in enumerate(uppers):
        if value <= hi:
            return i + 1
    return len(uppers) + 1


def _eaqi(pollutants: dict[str, float]) -> RegionalIndex | None:
    subs = [_band_index(v, b) for k, b in _EAQI_BANDS.items()
            if (v := pollutants.get(k)) is not None]
    if not subs:
        return None
    level = max(subs)
    label = _EAQI_LEVELS[level - 1]
    return RegionalIndex("EU EAQI", label, label, "Good→Extremely poor",
                         "European Environment Agency")


# ---------------------------------------------------------------------------
# UK — Daily Air Quality Index (DAQI), 1–10, worst pollutant. Bands are upper
# bounds (µg/m³); above the last → 10. Bandings: 1–3 Low, 4–6 Moderate,
# 7–9 High, 10 Very High (COMEAP).
# ---------------------------------------------------------------------------
_DAQI_BANDS = {
    "pm2_5": [11, 23, 35, 41, 47, 53, 58, 64, 70],
    "pm10": [16, 33, 50, 58, 66, 75, 83, 91, 100],
    "ozone": [33, 66, 100, 120, 140, 160, 187, 213, 240],
    "nitrogen_dioxide": [67, 134, 200, 267, 334, 400, 467, 534, 600],
    "sulphur_dioxide": [88, 177, 266, 354, 443, 532, 710, 887, 1064],
}


def _daqi_band(index: int) -> str:
    if index <= 3:
        return "Low"
    if index <= 6:
        return "Moderate"
    if index <= 9:
        return "High"
    return "Very High"


def _daqi(pollutants: dict[str, float]) -> RegionalIndex | None:
    subs = [_band_index(v, b) for k, b in _DAQI_BANDS.items()
            if (v := pollutants.get(k)) is not None]
    if not subs:
        return None
    index = max(subs)
    return RegionalIndex("UK DAQI", str(index), _daqi_band(index), "1–10",
                         "UK Defra / COMEAP")


# ---------------------------------------------------------------------------
# India — National Air Quality Index (NAQI), 0–500, worst pollutant. Sub-index
# is linearly interpolated within a pollutant's concentration band (CPCB).
# CO breakpoints are in mg/m³, so convert from µg/m³. Categories: 0–50 Good,
# 51–100 Satisfactory, 101–200 Moderate, 201–300 Poor, 301–400 Very Poor,
# 401–500 Severe.
# ---------------------------------------------------------------------------
# (C_lo, C_hi, I_lo, I_hi)
_NAQI_BP = {
    "pm2_5": [(0, 30, 0, 50), (31, 60, 51, 100), (61, 90, 101, 200),
              (91, 120, 201, 300), (121, 250, 301, 400), (251, 500, 401, 500)],
    "pm10": [(0, 50, 0, 50), (51, 100, 51, 100), (101, 250, 101, 200),
             (251, 350, 201, 300), (351, 430, 301, 400), (431, 600, 401, 500)],
    "nitrogen_dioxide": [(0, 40, 0, 50), (41, 80, 51, 100), (81, 180, 101, 200),
                         (181, 280, 201, 300), (281, 400, 301, 400), (401, 800, 401, 500)],
    "ozone": [(0, 50, 0, 50), (51, 100, 51, 100), (101, 168, 101, 200),
              (169, 208, 201, 300), (209, 748, 301, 400), (749, 1000, 401, 500)],
    "sulphur_dioxide": [(0, 40, 0, 50), (41, 80, 51, 100), (81, 380, 101, 200),
                        (381, 800, 201, 300), (801, 1600, 301, 400), (1601, 2000, 401, 500)],
    # CO in mg/m³:
    "carbon_monoxide": [(0, 1, 0, 50), (1.1, 2, 51, 100), (2.1, 10, 101, 200),
                        (10.1, 17, 201, 300), (17.1, 34, 301, 400), (34.1, 50, 401, 500)],
}
_NAQI_CATEGORIES = [
    (50, "Good"), (100, "Satisfactory"), (200, "Moderate"),
    (300, "Poor"), (400, "Very Poor"), (500, "Severe"),
]


def _naqi_sub(conc: float, bps: list[tuple]) -> float | None:
    for c_lo, c_hi, i_lo, i_hi in bps:
        if c_lo <= conc <= c_hi:
            return i_lo + (i_hi - i_lo) / (c_hi - c_lo) * (conc - c_lo)
    return 500.0 if conc > bps[-1][1] else None


def _naqi_category(index: float) -> str:
    for upper, label in _NAQI_CATEGORIES:
        if index <= upper:
            return label
    return "Severe"


def _naqi(pollutants: dict[str, float]) -> RegionalIndex | None:
    subs = []
    for k, bps in _NAQI_BP.items():
        v = pollutants.get(k)
        if v is None:
            continue
        if k == "carbon_monoxide":
            v = v / 1000.0  # µg/m³ → mg/m³
        s = _naqi_sub(v, bps)
        if s is not None:
            subs.append(s)
    if not subs:
        return None
    index = int(round(max(subs)))
    return RegionalIndex("India NAQI", str(index), _naqi_category(index), "0–500",
                         "India CPCB")


# Country → regional index. EAQI applies across the EU/EEA.
_EU_EEA = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
    "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
    "SE", "IS", "LI", "NO",
}


def regional_index(pollutants: dict[str, float], country_code: str | None) -> RegionalIndex | None:
    """The user's national index, if AirAware supports their country.

    Returns None elsewhere (the UI then shows US AQI + the WHO context only).
    """
    if not country_code:
        return None
    cc = country_code.upper()
    if cc == "GB":
        return _daqi(pollutants)
    if cc == "IN":
        return _naqi(pollutants)
    if cc in _EU_EEA:
        return _eaqi(pollutants)
    return None
