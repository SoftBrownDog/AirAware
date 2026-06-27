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
    escalated: bool = False  # risk raised one band for a sensitive group
    dominant_pollutant: str | None = None
    peak_window: str | None = None
    best_window: str | None = None
    cause: str | None = None  # cause key (see CAUSE_TEXT)
    cigarettes: float | None = None  # daily cigarette-equivalent
    windows: str | None = None  # open/close-the-windows recommendation

    @property
    def cause_text(self) -> str | None:
        return CAUSE_TEXT.get(self.cause) if self.cause else None

    def to_text(self, location: str | None = None) -> str:
        where = f" in {location}" if location else ""
        lines = [
            f"Air quality{where}: {self.category} (US AQI {self.aqi}).",
            f"For {GROUP_LABELS.get(self.group, self.group)}: {self.headline}",
            f"What to do: {self.action}",
        ]
        if self.escalated:
            lines.append("(Raised one level for you as a sensitive group.)")
        if self.cigarettes and self.cigarettes >= 0.1:
            lines.append(f"Roughly like smoking {self.cigarettes} cigarettes today.")
        if self.cause_text:
            lines.append(f"Why: {self.cause_text}")
        if self.dominant_pollutant:
            lines.append(f"Main concern: {self.dominant_pollutant}.")
        if self.windows:
            lines.append(f"Indoors: {self.windows}")
        if self.peak_window:
            lines.append(f"Worst window today: {self.peak_window} — plan around it.")
        if self.best_window:
            lines.append(f"Cleanest window: {self.best_window} — a good time to go out.")
        return "\n".join(lines)


def advise(
    aqi: float,
    group: str = "general",
    dominant_pollutant: str | None = None,
    peak_window: str | None = None,
    best_window: str | None = None,
    cause: str | None = None,
    cigarettes: float | None = None,
    trend: str | None = None,
) -> Advice:
    """Build personalized advice from an AQI value and a sensitivity group."""
    risk = personal_risk(aqi, group)
    category, color = aqi_category(aqi)
    headline, action, mask = _RISK_ADVICE[risk]
    escalated = group in SENSITIVE_GROUPS and risk != _base_risk(aqi)
    return Advice(
        aqi=int(round(aqi)),
        category=category,
        color=color,
        group=group,
        risk=risk,
        headline=headline,
        action=action,
        wear_mask=mask,
        escalated=escalated,
        dominant_pollutant=dominant_pollutant,
        peak_window=peak_window,
        best_window=best_window,
        cause=cause,
        cigarettes=cigarettes,
        windows=window_advice(aqi, trend),
    )


# Berkeley Earth equivalence: a daily PM2.5 average of ~22 µg/m³ over 24h is
# roughly one cigarette's worth of harm. Framed daily (long-term equivalence),
# not as a single-hour claim, to stay scientifically honest.
CIGARETTE_PM25_PER_DAY = 22.0


def cigarettes_equivalent(pm25: float | None, hours: float = 24.0) -> float:
    """Cigarette-equivalent of breathing `pm25` µg/m³ for `hours` hours."""
    if pm25 is None or pm25 < 0:
        return 0.0
    return round((pm25 / CIGARETTE_PM25_PER_DAY) * (hours / 24.0), 2)


def window_advice(aqi: float, trend: str | None = None) -> str:
    """Open/close-the-windows recommendation from outdoor AQI and its trend."""
    if aqi <= 75:
        msg = "Outdoor air is clean enough — open the windows to ventilate."
        if trend == "rising":
            msg = "OK to air out now, but close up soon — air quality is worsening."
        return msg
    msg = "Keep the windows closed and filter your indoor air."
    if trend == "falling":
        msg += " Air is improving — you may be able to air out later."
    return msg


# Right-sized indoor protective actions, revealed on demand (progressive depth).
INDOOR_PLAYBOOK = [
    "Run a HEPA purifier sized to the room (look for a CADR near the room's area in ft²).",
    "No purifier? A box fan with a taped-on MERV-13 filter (a Corsi-Rosenthal box) works well.",
    "Pick one room to keep cleanest — close its door and run the filter there.",
    "Ventilate only when outdoor air is better than indoor; otherwise keep it sealed.",
]


def combined_risk(aqi: float, groups: list[str]) -> tuple[str, str]:
    """Household verdict: the highest risk across the selected groups.

    Returns (risk_level, driving_group) so the UI can say who it's pitched to.
    """
    chosen = groups or ["general"]
    ranked = [(personal_risk(aqi, g), g) for g in chosen]
    return max(ranked, key=lambda rg: _RISK_ORDER.index(rg[0]))


# Plain-language causes for classify_cause() keys (see data.classify_cause).
CAUSE_TEXT = {
    "smoke": "Fine particles (PM2.5) dominate — typically smoke from wildfires, "
             "burning, or combustion.",
    "dust": "Coarse particles (PM10) dominate — often wind-blown dust or sand.",
    "ozone_smog": "Ground-level ozone (smog), which builds up in hot, sunny, "
                  "stagnant air.",
    "traffic": "Nitrogen dioxide, mostly from traffic and combustion.",
    "industrial": "Sulfur dioxide, usually from industry or burning fossil fuels.",
    "combustion": "Carbon monoxide from combustion — traffic, heating, or fire.",
    "mixed": "A mix of everyday urban sources.",
}


# Human-friendly names for Open-Meteo pollutant keys.
POLLUTANT_NAMES = {
    "pm2_5": "fine particles (PM2.5) — typical of wildfire smoke",
    "pm10": "coarse particles (PM10) — dust/smoke",
    "ozone": "ground-level ozone (smog)",
    "nitrogen_dioxide": "nitrogen dioxide (traffic pollution)",
    "sulphur_dioxide": "sulfur dioxide",
    "carbon_monoxide": "carbon monoxide",
}
