# AirAware

**Plain-language, personalized air-quality advice for the people who need it most.**

🌐 **Live site:** https://softbrowndog.github.io/AirAware/

Air-quality numbers are everywhere; *useful* guidance isn't. Wildfire smoke and
smog hit some people — those with asthma or COPD, heart conditions, the elderly,
pregnant people, young children, and outdoor workers — far harder than generic
"AQI is moderate" messaging suggests. AirAware turns a place name into a clear
answer: **what does today's air mean for *me*, and what should I do about it?**

## Highlights

- **Free, no API key, global.** Runs on [Open-Meteo](https://open-meteo.com/)'s
  open air-quality and geocoding APIs. Stdlib-only — no install step.
- **Finds the *right* place.** Region/country hints disambiguate ambiguous
  names ("Salisbury, England" vs the US Salisburys; "Columbus OH"), and the web
  app has a one-tap **Use my location** button (reverse-geocoded, no key).
- **Personalized.** Sensitive groups get protective advice one band sooner,
  following US EPA guidance.
- **Actionable.** Mask recommendations, the dominant pollutant in plain English
  (e.g. "fine particles (PM2.5) — typical of wildfire smoke"), and the worst
  window of the day to plan around.
- **Trustworthy.** The risk model is pure, transparent logic with tests.

## The website

`docs/` is a **fully client-side** version of AirAware — no server required. It
calls the same free, key-less, CORS-enabled APIs directly from the browser, so
it can be hosted as static files (e.g. **GitHub Pages**, served from `/docs`).

Run it locally with any static server:

```bash
python -m http.server -d docs 8000   # then open http://localhost:8000
```

`web/server.py` is an alternative stdlib server that exposes the Python engine
over a small JSON API — handy for local development or non-static hosting.

## Usage (CLI)

```bash
cd src
python -m airaware.cli "Fresno, CA"
python -m airaware.cli "Delhi" --group respiratory
python -m airaware.cli "Jakarta" --group child --json
```

Groups: `general`, `respiratory`, `heart`, `older_adult`, `pregnant`, `child`,
`outdoor_worker`.

### Example

```
Air quality in Delhi, ...: Unhealthy (US AQI 174).
For people with asthma or COPD: Air quality is very unhealthy.
What to do: Stay indoors with windows closed and air filtered. Avoid all
outdoor exertion. Wear an N95 outdoors. Have rescue medication on hand.
Main concern: fine particles (PM2.5) — typical of wildfire smoke.
Worst window today: around 18:00 (US AQI ~175) — plan around it.
```

## Tests

```bash
python -m pytest -q tests
```

## Roadmap

- Active-fire / smoke overlay (NASA FIRMS) and heat-wave alerts (NWS).
- Email/SMS/push alerts when air crosses a personal threshold.
- A simple web page so non-technical people can use it.
- Localization for the communities most exposed to poor air.

## Intent

AirAware is built as a public good: free to use, open data, no tracking. Any
future hosting is owned and operated by a named human/entity — not an automated
agent.

## License

MIT
