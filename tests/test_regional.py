"""Tests for WHO-context and locale-aware regional indices (pure logic)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from airaware.regional import (  # noqa: E402
    regional_index,
    who_pm25_multiple,
)


def test_who_pm25_multiple():
    assert who_pm25_multiple(15) == 1.0
    assert who_pm25_multiple(30) == 2.0
    assert who_pm25_multiple(89.2) == 5.9
    assert who_pm25_multiple(None) is None
    assert who_pm25_multiple(-1) is None


# ---- EU EAQI (worst sub-index, band upper bounds) ----

def test_eaqi_by_country_and_bands():
    r = regional_index({"pm2_5": 10}, "FR")        # France, EU
    assert r is not None and r.system == "EU EAQI"
    assert r.label == "Good"                        # pm2_5 10 → band 1
    assert regional_index({"pm2_5": 22}, "DE").label == "Moderate"  # 22 → band 3
    assert regional_index({"pm2_5": 60}, "ES").label == "Very poor"  # 60 → band 5


def test_eaqi_uses_worst_pollutant():
    # PM2.5 "Good" but NO2 "Poor" → overall "Poor".
    r = regional_index({"pm2_5": 8, "nitrogen_dioxide": 200}, "IT")
    assert r.label == "Poor"


# ---- UK DAQI (1–10, worst pollutant) ----

def test_daqi_index_and_band():
    assert regional_index({"pm2_5": 10}, "GB").value == "1"   # ≤11
    r = regional_index({"pm2_5": 60}, "GB")                   # 58<60≤64 → 8
    assert r.system == "UK DAQI" and r.value == "8" and r.label == "High"
    assert regional_index({"pm2_5": 200}, "GB").value == "10"  # above top → 10
    assert regional_index({"pm2_5": 200}, "GB").label == "Very High"


def test_daqi_lowercase_country_code():
    assert regional_index({"pm2_5": 10}, "gb").system == "UK DAQI"


# ---- India NAQI (0–500, interpolated sub-index, worst pollutant) ----

def test_naqi_interpolation_and_category():
    # PM2.5 = 45 sits mid-band 31–60 → I 51–100 → 75.something → "Satisfactory".
    r = regional_index({"pm2_5": 45}, "IN")
    assert r.system == "India NAQI"
    assert r.label == "Satisfactory"
    assert 70 <= int(r.value) <= 80


def test_naqi_severe_for_heavy_pm25():
    r = regional_index({"pm2_5": 300}, "IN")
    assert r.label == "Severe"


def test_naqi_co_converted_from_ug_to_mg():
    # 15000 µg/m³ = 15 mg/m³ → band (10.1–17) → Poor range.
    r = regional_index({"carbon_monoxide": 15000}, "IN")
    assert r.label == "Poor"


# ---- Canada AQHI (ppb conversion: O3×0.70, NO2×0.53) ----
#
# Official formula (Health Canada):
#   AQHI = (10/10.4) × 100 × [(exp(0.000537×O3_ppb)-1)
#                             + (exp(0.000871×NO2_ppb)-1)
#                             + (exp(0.000487×PM2.5)-1)]
# Open-Meteo reports O3 and NO2 in µg/m³. Conversion factors (O3×0.70,
# NO2×0.53) are empirically calibrated against live weather.gc.ca readings.

def test_aqhi_pm25_only():
    r = regional_index({"pm2_5": 5}, "CA")
    assert r.system == "Canada AQHI" and r.value == "1" and r.label == "Low"
    r = regional_index({"pm2_5": 35}, "CA")
    assert r.value == "2" and r.label == "Low"
    r = regional_index({"pm2_5": 100}, "CA")
    assert r.value == "5" and r.label == "Moderate"
    r = regional_index({"pm2_5": 150}, "CA")
    assert r.value == "7" and r.label == "High"
    r = regional_index({"pm2_5": 200}, "CA")
    assert r.value == "10" and r.label == "High"


def test_aqhi_ozone_ppb_conversion():
    # O3=50 µg/m³ → 35 ppb → AQHI=2 Low.
    r = regional_index({"ozone": 50}, "CA")
    assert r.system == "Canada AQHI" and r.value == "2" and r.label == "Low"


def test_aqhi_no2_ppb_conversion():
    # NO2=50 µg/m³ → 26.5 ppb → AQHI=2 Low.
    r = regional_index({"nitrogen_dioxide": 50}, "CA")
    assert r.system == "Canada AQHI" and r.value == "2" and r.label == "Low"


def test_aqhi_combined_ozone_no2_pm25():
    # Moderate across all three: PM2.5=35(AQHI~2), O3=30ug/m=21ppb, NO2=30ug/m=16ppb
    # Combined ~4 → Moderate.
    r = regional_index({"pm2_5": 35, "ozone": 30, "nitrogen_dioxide": 30}, "CA")
    assert r.system == "Canada AQHI" and r.value == "4" and r.label == "Moderate"


def test_aqhi_very_high():
    r = regional_index({"pm2_5": 300}, "CA")
    assert r.value == "15" and r.label == "Very High"


def test_aqhi_null_when_no_pollutants():
    assert regional_index({}, "CA") is None
    assert regional_index({"pm10": 50}, "CA") is None  # AQHI only uses O3/NO2/PM2.5


# ---- Country mapping fallbacks ----

def test_no_regional_index_for_unsupported_country():
    assert regional_index({"pm2_5": 30}, "US") is None
    assert regional_index({"pm2_5": 30}, None) is None


def test_regional_none_when_no_pollutants():
    assert regional_index({}, "GB") is None
