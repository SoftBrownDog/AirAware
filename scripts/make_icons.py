"""Generate AirAware PWA icons (teal disc + white 'wind' wave) from code.

Run: python scripts/make_icons.py  →  docs/icons/*.png
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

TEAL = (14, 165, 160, 255)
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parents[1] / "docs" / "icons"


def _wind_curve(d, cx, cy, w, amp, width):
    pts = []
    for i in range(101):
        t = i / 100
        x = cx - w / 2 + t * w
        y = cy - amp * math.sin(t * math.pi * 2)
        pts.append((x, y))
    d.line(pts, fill=WHITE, width=width, joint="curve")


def make(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:  # full-bleed background for the maskable safe area
        d.rectangle([0, 0, size, size], fill=TEAL)
        scale = 0.60
    else:
        pad = size * 0.06
        d.ellipse([pad, pad, size - pad, size - pad], fill=TEAL)
        scale = 0.78
    _wind_curve(d, size / 2, size / 2, size * scale, size * 0.085, max(2, int(size * 0.075)))
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (192, 512):
        make(s).save(OUT / f"icon-{s}.png")
    make(512, maskable=True).save(OUT / "maskable-512.png")
    ios = Image.new("RGBA", (180, 180), TEAL)
    ios.alpha_composite(make(180))
    ios.convert("RGB").save(OUT / "apple-touch-icon.png")
    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
