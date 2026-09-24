# TRMNL Drive Time

A [TRMNL](https://trmnl.com) plugin backend that shows your commute at a glance:

- **Live drive time** on the fastest route right now, your arrival time, and how much traffic is adding.
- **Accidents and other incidents on your route**: crashes, closures, stalled vehicles, and jams that are costing time. Only incidents on your side of the road and in your direction of travel are shown.
- **A route map built for e-ink**: greyscale, no clutter, your route in bold, slowdowns shaded, and numbered markers that match the incident list.
- **A short route summary**: the main roads you'll take in order (e.g. `NE 8th St → I-405 S → WA-520 W`) and how the chosen route compares with the next-best one.

## How it works

1. `GET /drive-time` asks the Google **Routes API** for every traffic-aware route (`TRAFFIC_AWARE_OPTIMAL`, the same exhaustive search Google Maps uses) and keeps the fastest.
2. If `TOMTOM_API_KEY` is set, it pulls live incidents from the **TomTom Traffic Incident Details API** around the route and keeps the ones that are actually on it.
3. It returns JSON for TRMNL's polling strategy, including a signed `map_url`.
4. `GET /map` draws that route with **Google Static Maps**. The route travels inside the signed URL, so your Google key never appears in the TRMNL markup and nobody else can use the endpoint.

## Setup

### 1. API keys

- **Google** ([console](https://console.cloud.google.com/google/maps-apis)): enable **Routes API** and **Maps Static API** on your key. The old *Directions API* is no longer needed.
- **TomTom** (optional, recommended, needed for incidents): create a free key at [developer.tomtom.com](https://developer.tomtom.com).

### 2. Deploy to Vercel

Set these environment variables (see [`.env.example`](.env.example)):

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_API_KEY` | yes | Routes API + Maps Static API |
| `HOME_ADDRESS`, `WORK_ADDRESS` | yes | Any address Google Maps understands |
| `TOMTOM_API_KEY` | recommended | Turns on incidents |
| `HOME_LABEL`, `WORK_LABEL` | no | Labels shown on screen (default `Home`, `Work`) |
| `TIMEZONE` | no | For arrival and updated times (default `America/Los_Angeles`) |
| `REVERSE_AFTER_HOUR` | no | e.g. `12` shows work → home from noon onwards |
| `AVOID_TOLLS`, `AVOID_HIGHWAYS` | no | `true` to avoid |
| `PUBLIC_BASE_URL` | no | Used in `map_url`; detected from the request if unset |
| `MAP_SIGNING_SECRET` | no | Secret for signing map URLs; defaults to the Google key |

You can force a direction with `?direction=work` or `?direction=home`.

### 3. Create the TRMNL private plugin

- Strategy: **Polling**
- Polling URL: `https://<your-app>.vercel.app/drive-time`
- Refresh: every **15 minutes** keeps Google usage inside the free monthly tier (see below).
- Markup: paste the templates from [`trmnl/`](trmnl) into the matching layout tabs (`full`, `half_horizontal`, `half_vertical`, `quadrant`).

Markup written for the original version still works: `{{ time }}` and `{{ staticMapUrl }}` are still returned.

## Payload

Main fields (see `lib/commute.js` for everything):

```jsonc
{
  "duration_min": 34, "duration": "34 min", "typical_min": 25, "delay_min": 9,
  "traffic": "moderate",                       // light | moderate | heavy
  "headline": "Moderate traffic, +9 min · 1 accident on route",
  "arrive_by": "8:42 AM", "updated_at": "8:08 AM", "distance": "18.2 mi",
  "via": "I-405 S",
  "route_summary": "NE 8th St → I-405 S → WA-520 W",
  "route_count": 3, "alternative_summary": "6 min faster than I-5 S",
  "alternatives": [{ "via": "I-5 S", "minutes": 40, "extra_min": 6, "distance": "21 mi" }],
  "incidents": [{
    "number": 1, "type": "Accident", "is_accident": true, "road": "I-405",
    "where": "NE 8th St → NE 4th St", "delay": "+7 min", "ahead": "in 3.1 mi"
  }],
  "incident_count": 1, "accident_count": 1,
  "map_url": "https://<your-app>/map?d=…&s=…"  // add &w=…&h=… (100–640) to size it
}
```

## Cost

With Google's per-SKU free monthly usage (in effect since March 2025), traffic-aware routing is billed as **Compute Routes Pro** (5,000 free requests a month) and Static Maps as Essentials (10,000 free). Refreshing every 15 minutes is about 2,900 of each a month. TomTom's free tier has allowed 2,500 non-tile requests a day (one per refresh here), but TomTom revised its pricing in July 2026. Check current pricing for both before refreshing more often.

## Development

```bash
cp .env.example .env   # fill in keys
npm run dev            # http://localhost:3000/drive-time
npm test               # offline tests with Google/TomTom stubbed
```

No runtime dependencies. Requires Node 22+.
