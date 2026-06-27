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
    personal_risk,
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
