#!/usr/bin/env python3
"""Build docs/standalone.html by inlining styles.css and app.js into index.html.

The standalone file is a single, dependency-free page (apart from the Google
Fonts <link>) so it can be hosted by dropping one file anywhere.
"""
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"


def main() -> None:
    html = (DOCS / "index.html").read_text(encoding="utf-8")
    css = (DOCS / "styles.css").read_text(encoding="utf-8")
    js = (DOCS / "app.js").read_text(encoding="utf-8")

    html = html.replace(
        '<link rel="stylesheet" href="styles.css" />',
        f"<style>\n{css}\n</style>",
    )
    html = html.replace(
        '<script src="app.js"></script>',
        f"<script>\n{js}\n</script>",
    )

    out = DOCS / "standalone.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
