"""Turn an air-quality reading into clear, personalized, health-protective advice.

The hard part of air-quality data isn't getting a number — it's telling a real
person *what to do about it today*, tuned to how vulnerable they are. Wildfire
smoke and ground-level ozone hit some people (asthma/COPD, heart conditions,
the elderly, pregnant people, young children, outdoor workers) far harder than
the general "AQI is moderate" messaging implies.

This module is pure logic (no network), so the risk model is easy to test and
trust. Thresholds follow the US EPA AQI categories, with a one-band escalation
for sensitive groups — mirroring EPA guidance that sensitive people should act
sooner.
"""

from __future__ import annotations

from dataclasses import dataclass

# US EPA AQI category breakpoints (upper bound -> label, color).
AQI_CATEGORIES = [
    (50, "Good", "green"),
    (100, "Moderate", "yellow"),
    (150, "Unhealthy for Sensitive Groups", "orange"),
    (200, "Unhealthy", "red"),
    (300, "Very Unhealthy", "purple"),
    (500, "Hazardous", "maroon"),
]

# Groups that the EPA flags as more susceptible. "general" is the baseline.
SENSITIVE_GROUPS = {
    "respiratory",   # asthma, COPD
    "heart",         # cardiovascular disease
    "older_adult",
    "pregnant",
    "child",
    "outdoor_worker",
}
KNOWN_GROUPS = {"general"} | SENSITIVE_GROUPS

GROUP_LABELS = {
    "general": "the general public",
    "respiratory": "people with asthma or COPD",
    "heart": "people with heart conditions",
    "older_adult": "older adults",
    "pregnant": "people who are pregnant",
    "child": "children",
    "outdoor_worker": "people working outdoors",
}

# Personal risk ladder, from least to most severe.
_RISK_ORDER = ["none", "low", "moderate", "high", "very_high", "severe"]

# Risk level -> (headline, action, recommend N95 mask outdoors).
_RISK_ADVICE = {
    "none": ("Air quality is good.",
             "Enjoy normal outdoor activity.", False),
    "low": ("Air quality is acceptable.",
            "Fine for most; if you're unusually sensitive, watch for symptoms.", False),
    "moderate": ("Air quality may affect you.",
                 "Reduce prolonged or heavy outdoor exertion; take breaks indoors.", False),
    "high": ("Air quality is unhealthy for you.",
             "Avoid outdoor exertion. Keep windows closed; run a purifier if you have one. "
             "Wear a well-fitted N95 if you must go out.", True),
    "very_high": ("Air quality is very unhealthy.",
                  "Stay indoors with windows closed and air filtered. Avoid all outdoor "
                  "exertion. Wear an N95 outdoors. Have rescue medication on hand.", True),
    "severe": ("Air quality is hazardous — a health emergency.",
               "Stay indoors with filtered air. Do not go outside unless necessary; wear an "
               "N95 if you must. Seek medical help for any breathing difficulty.", True),
}


def aqi_category(aqi: float) -> tuple[str, str]:
    """Return (label, color) for a US AQI value."""
    for upper, label, color in AQI_CATEGORIES:
        if aqi <= upper:
            return label, color
    return "Hazardous", "maroon"


def _base_risk(aqi: float) -> str:
    if aqi <= 50:
        return "none"
    if aqi <= 100:
        return "low"
    if aqi <= 150:
        return "moderate"
    if aqi <= 200:
        return "high"
    if aqi <= 300:
        return "very_high"
    return "severe"


def personal_risk(aqi: float, group: str = "general") -> str:
    """Risk level for a specific group; sensitive groups escalate one band."""
    if group not in KNOWN_GROUPS:
        raise ValueError(f"unknown group {group!r}; choose from {sorted(KNOWN_GROUPS)}")
    level = _base_risk(aqi)
    if group in SENSITIVE_GROUPS and level not in ("severe",):
        idx = min(_RISK_ORDER.index(level) + 1, len(_RISK_ORDER) - 1)
        level = _RISK_ORDER[idx]
    return level


@dataclass
class Advice:
    aqi: int
    category: str
    color: str
    group: str
    risk: str
    headline: str
    action: str
    wear_mask: bool
    dominant_pollutant: str | None = None
    peak_window: str | None = None

    def to_text(self, location: str | None = None) -> str:
        where = f" in {location}" if location else ""
        lines = [
            f"Air quality{where}: {self.category} (US AQI {self.aqi}).",
            f"For {GROUP_LABELS.get(self.group, self.group)}: {self.headline}",
            f"What to do: {self.action}",
        ]
        if self.dominant_pollutant:
            lines.append(f"Main concern: {self.dominant_pollutant}.")
        if self.peak_window:
            lines.append(f"Worst window today: {self.peak_window} — plan around it.")
        return "\n".join(lines)


def advise(
    aqi: float,
    group: str = "general",
    dominant_pollutant: str | None = None,
    peak_window: str | None = None,
) -> Advice:
    """Build personalized advice from an AQI value and a sensitivity group."""
    risk = personal_risk(aqi, group)
    category, color = aqi_category(aqi)
    headline, action, mask = _RISK_ADVICE[risk]
    return Advice(
        aqi=int(round(aqi)),
        category=category,
        color=color,
        group=group,
        risk=risk,
        headline=headline,
        action=action,
        wear_mask=mask,
        dominant_pollutant=dominant_pollutant,
        peak_window=peak_window,
    )


# Human-friendly names for Open-Meteo pollutant keys.
POLLUTANT_NAMES = {
    "pm2_5": "fine particles (PM2.5) — typical of wildfire smoke",
    "pm10": "coarse particles (PM10) — dust/smoke",
    "ozone": "ground-level ozone (smog)",
    "nitrogen_dioxide": "nitrogen dioxide (traffic pollution)",
    "sulphur_dioxide": "sulfur dioxide",
    "carbon_monoxide": "carbon monoxide",
}
