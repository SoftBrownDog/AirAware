"""AirAware web server: tiny stdlib HTTP server serving the site + a JSON API.

Routes:
    GET /                       -> static/index.html
    GET /<asset>                -> static files
    GET /api/advice?location=&group=  -> personalized air-quality advice (JSON)

No third-party dependencies, so it runs anywhere Python does.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from airaware.advice import KNOWN_GROUPS  # noqa: E402
from airaware.cli import run, run_coords  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "AirAware/0.1"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: dict):
        self._send(status, json.dumps(obj).encode(), CONTENT_TYPES[".json"])

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/advice":
            return self._api_advice(parsed)
        return self._static(parsed.path)

    do_HEAD = do_GET

    def _api_advice(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        location = (qs.get("location", [""])[0]).strip()
        group = (qs.get("group", ["general"])[0]).strip() or "general"
        lat_raw = (qs.get("lat", [""])[0]).strip()
        lon_raw = (qs.get("lon", [""])[0]).strip()
        if group not in KNOWN_GROUPS:
            return self._json(400, {"error": f"Unknown group {group!r}."})

        coords = None
        if lat_raw and lon_raw:
            try:
                coords = (float(lat_raw), float(lon_raw))
            except ValueError:
                return self._json(400, {"error": "Invalid coordinates."})
            if not (-90 <= coords[0] <= 90 and -180 <= coords[1] <= 180):
                return self._json(400, {"error": "Coordinates out of range."})
        elif not location:
            return self._json(400, {"error": "Please enter a location."})

        try:
            out = run_coords(coords[0], coords[1], group) if coords else run(location, group)
        except LookupError:
            return self._json(
                404, {"error": f"Couldn't find a place called \u201c{location}\u201d."}
            )
        except Exception:  # noqa: BLE001
            return self._json(
                502, {"error": "Air-quality service is unavailable right now. Try again."}
            )
        place, reading, a = out["place"], out["reading"], out["advice"]
        payload = {
            "location": place.label,
            "latitude": place.latitude,
            "longitude": place.longitude,
            "observed_at": reading.time,
            "pollutants": reading.pollutants,
            **a.__dict__,
        }
        return self._json(200, payload)

    def _static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if STATIC not in target.parents and target != STATIC:
            return self._send(403, b"Forbidden", "text/plain")
        if not target.is_file():
            return self._send(404, b"Not found", "text/plain")
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 12000
    host = "0.0.0.0"
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"AirAware serving on http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
