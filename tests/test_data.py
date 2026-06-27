"""Tests for the pure data-shaping helpers (no network)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from airaware.data import (  # noqa: E402
    _attempts,
    _best_match,
    _dominant,
    _peak_window,
)


# Synthetic geocoder candidates resembling Open-Meteo's "Salisbury" results,
# in the order the API returns them (US ones first).
SALISBURY = [
    {"name": "Salisbury", "admin1": "North Carolina", "country": "United States",
     "country_code": "US", "population": 34017, "latitude": 35.67, "longitude": -80.47},
    {"name": "Salisbury", "admin1": "Maryland", "country": "United States",
     "country_code": "US", "population": 32899, "latitude": 38.36, "longitude": -75.6},
    {"name": "Salisbury", "admin1": "England", "country": "United Kingdom",
     "country_code": "GB", "population": 44748, "latitude": 51.07, "longitude": -1.79},
]


def test_best_match_uses_region_hint():
    m = _best_match(SALISBURY, ["England"])
    assert m["country_code"] == "GB"


def test_best_match_country_alias_uk():
    m = _best_match(SALISBURY, ["UK"])
    assert m["country_code"] == "GB"


def test_best_match_us_state_abbreviation():
    m = _best_match(SALISBURY, ["MD"])
    assert m["admin1"] == "Maryland"


def test_best_match_no_hint_keeps_api_order():
    m = _best_match(SALISBURY, [])
    assert m["admin1"] == "North Carolina"


def test_best_match_unmatched_hint_falls_back():
    m = _best_match(SALISBURY, ["Atlantis"])
    assert m is SALISBURY[0]


def test_attempts_splits_multiword_and_comma():
    assert _attempts("Salisbury England") == [
        ("Salisbury England", []),
        ("Salisbury", ["England"]),
        ("Salisbury", ["England"]),
    ]
    assert _attempts("Fresno, CA") == [("Fresno", ["CA"])]





def test_dominant_is_health_normalized_not_raw():
    # CO reads high in raw µg/m³ but is harmless here; PM2.5 should win.
    pollutants = {"pm2_5": 30.0, "carbon_monoxide": 200.0, "ozone": 20.0}
    assert _dominant(pollutants) == "pm2_5"


def test_dominant_picks_smog_when_ozone_elevated():
    pollutants = {"pm2_5": 8.0, "ozone": 160.0, "carbon_monoxide": 150.0}
    assert _dominant(pollutants) == "ozone"


def test_dominant_handles_empty():
    assert _dominant({}) is None


def test_peak_window_only_flags_elevated():
    hourly = {
        "time": ["2026-06-26T00:00", "2026-06-26T18:00"],
        "us_aqi": [40, 50],  # never above the 75 threshold
    }
    assert _peak_window(hourly) is None


def test_peak_window_reports_worst_hour():
    hourly = {
        "time": ["2026-06-26T00:00", "2026-06-26T18:00"],
        "us_aqi": [40, 180],
    }
    out = _peak_window(hourly)
    assert out is not None
    assert "18:00" in out
