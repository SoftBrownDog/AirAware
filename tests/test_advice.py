"""Tests for AirAware's health-advice logic.

Pure logic, no network, no mocks. We assert that the risk model matches EPA
intuition and that sensitive groups are protected sooner than the general public.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402

from airaware.advice import (  # noqa: E402
    advise,
    aqi_category,
    cigarettes_equivalent,
    combined_risk,
    personal_risk,
    window_advice,
)


def test_category_boundaries():
    assert aqi_category(0)[0] == "Good"
    assert aqi_category(50)[0] == "Good"
    assert aqi_category(51)[0] == "Moderate"
    assert aqi_category(150)[0] == "Unhealthy for Sensitive Groups"
    assert aqi_category(200)[0] == "Unhealthy"
    assert aqi_category(301)[0] == "Hazardous"
    assert aqi_category(9999)[0] == "Hazardous"


def test_general_population_risk_ladder():
    assert personal_risk(30, "general") == "none"
    assert personal_risk(80, "general") == "low"
    assert personal_risk(120, "general") == "moderate"
    assert personal_risk(180, "general") == "high"
    assert personal_risk(250, "general") == "very_high"
    assert personal_risk(400, "general") == "severe"


def test_sensitive_group_escalates_one_band():
    # At AQI 80 ("Moderate"), general public is "low" but asthma patients
    # should already be at "moderate" concern.
    assert personal_risk(80, "general") == "low"
    assert personal_risk(80, "respiratory") == "moderate"
    assert personal_risk(120, "child") == "high"
    assert personal_risk(120, "general") == "moderate"


def test_sensitive_group_never_exceeds_severe():
    assert personal_risk(450, "older_adult") == "severe"


def test_mask_recommended_only_when_unhealthy():
    assert advise(40, "general").wear_mask is False
    assert advise(80, "general").wear_mask is False
    # Smoke event: AQI 175 is "high" for everyone -> mask.
    assert advise(175, "general").wear_mask is True
    # Same AQI, asthma -> very_high, definitely mask.
    assert advise(175, "respiratory").wear_mask is True


def test_wildfire_smoke_scenario_message():
    a = advise(165, "respiratory", dominant_pollutant="fine particles (PM2.5)")
    assert a.risk == "very_high"
    text = a.to_text(location="Paradise, CA")
    assert "Paradise, CA" in text
    assert "N95" in a.action or "N95" in text
    assert "PM2.5" in text


def test_unknown_group_rejected():
    with pytest.raises(ValueError):
        personal_risk(100, "robot")


def test_json_serializable_fields():
    a = advise(120, "heart")
    d = a.__dict__
    assert d["aqi"] == 120
    assert d["group"] == "heart"
    assert d["risk"] == "high"


# ---- Cigarette-equivalent (Berkeley Earth: 22 µg/m³·day = 1 cigarette) ----

def test_cigarettes_equivalent_ratio():
    assert cigarettes_equivalent(22.0) == 1.0
    assert cigarettes_equivalent(44.0) == 2.0
    assert cigarettes_equivalent(11.0) == 0.5
    assert cigarettes_equivalent(22.0, hours=12) == 0.5  # half a day
    assert cigarettes_equivalent(None) == 0.0
    assert cigarettes_equivalent(-5) == 0.0


# ---- Open/close-the-windows advice ----

def test_window_advice_opens_when_clean_closes_when_dirty():
    assert "open the windows" in window_advice(40).lower()
    assert "closed" in window_advice(160).lower()


def test_window_advice_respects_trend():
    assert "close up soon" in window_advice(40, "rising").lower()
    assert "improving" in window_advice(160, "falling").lower()


# ---- Household combined verdict ----

def test_combined_risk_takes_most_vulnerable_member():
    # At AQI 80, general is "low" but a respiratory member is "moderate".
    risk, who = combined_risk(80, ["general", "respiratory"])
    assert risk == "moderate"
    assert who == "respiratory"


def test_combined_risk_defaults_to_general():
    assert combined_risk(80, []) == ("low", "general")


# ---- Escalation flag surfaces personalization ----

def test_escalated_flag_set_for_sensitive_group():
    assert advise(80, "respiratory").escalated is True
    assert advise(80, "general").escalated is False
    # Capped at severe: no escalation beyond the top band.
    assert advise(450, "older_adult").escalated is False


def test_advise_threads_new_fields():
    a = advise(
        160, "respiratory",
        dominant_pollutant="fine particles (PM2.5)",
        best_window="tomorrow 07:00–10:00 (US AQI ~30)",
        cause="smoke",
        cigarettes=3.4,
    )
    text = a.to_text(location="Paradise, CA")
    assert "3.4 cigarettes" in text
    assert "smoke" in text.lower()
    assert "Cleanest window" in text
    assert a.cause_text is not None
