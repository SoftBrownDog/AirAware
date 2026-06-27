"""AirAware CLI: a plain-language, personalized air-quality answer for a place.

Examples:
    python -m airaware.cli "Fresno, CA"
    python -m airaware.cli "Delhi" --group respiratory
    python -m airaware.cli "Sydney" --group child --json
"""

from __future__ import annotations

import argparse
import json
import sys

from .advice import KNOWN_GROUPS, POLLUTANT_NAMES, advise
from .data import air_quality, geocode, reverse_geocode


def _build(place, group: str) -> dict:
    reading = air_quality(place.latitude, place.longitude)
    dom = POLLUTANT_NAMES.get(reading.dominant_pollutant, reading.dominant_pollutant)
    a = advise(
        reading.aqi,
        group=group,
        dominant_pollutant=dom,
        peak_window=reading.peak_window,
    )
    return {"place": place, "reading": reading, "advice": a}


def run(location: str, group: str) -> dict:
    return _build(geocode(location), group)


def run_coords(lat: float, lon: float, group: str) -> dict:
    return _build(reverse_geocode(lat, lon), group)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="airaware", description=__doc__)
    p.add_argument("location", help="place name, e.g. 'Fresno, CA'")
    p.add_argument(
        "--group",
        default="general",
        choices=sorted(KNOWN_GROUPS),
        help="who the advice is for (sensitive groups get earlier caution)",
    )
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args(argv)

    try:
        out = run(args.location, args.group)
    except LookupError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - surface a clean message to the user
        print(f"Error fetching air quality: {e}", file=sys.stderr)
        return 1

    place, reading, a = out["place"], out["reading"], out["advice"]

    if args.json:
        payload = {
            "location": place.label,
            "latitude": place.latitude,
            "longitude": place.longitude,
            "observed_at": reading.time,
            "pollutants": reading.pollutants,
            **a.__dict__,
        }
        json.dump(payload, sys.stdout, indent=2)
        print()
        return 0

    print(a.to_text(location=place.label))
    if a.wear_mask:
        print("\n\u26a0\ufe0f  An N95/FFP2 mask is recommended outdoors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
