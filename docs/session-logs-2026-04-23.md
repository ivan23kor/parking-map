# Handoff: browser log triage — 2026-04-23

## Context
Unified browser logger now relays all frontend logs/errors to `logs/browser.log`. See commit `3a452ba` and `js/logger.js`. After enabling, a real user session produced three entries worth investigating.

## Entries (14:34:43 UTC, path `/`)

```
[14:34:43.231Z] [INFO]  / [area-scan] initialized
[14:34:43.248Z] [ERROR] / [xhr-error] GET https://maps.googleapis.com/maps/api/mapsjs/gen_204?csp_test=true
[14:34:46.113Z] [ERROR] / [fetch-error] GET http://127.0.0.1:8000/streets?south=42.36239…&west=-71.09709…&north=42.36264…&east=-71.09621… Failed to fetch
```

## Observations

### 1. `[area-scan] initialized` — INFO
Emitted from `js/area-scan.js:624` at module load. Confirms that the area-scan subsystem wired up fine. Nothing actionable.

### 2. XHR error: `gen_204?csp_test=true` — ERROR
- Source: Google Maps JS loader probing for CSP support. Google fires an XHR/image to `gen_204` (always returns 204 when it works) on boot.
- The logger's new XHR wrapper (`js/logger.js` XMLHttpRequest hook) reported this as `[xhr-error]`.
- The probe is non-fatal — Google Maps loads regardless. Matches one of the examples the user originally asked us to capture ("net::ERR_BLOCKED_BY_CLIENT"-class).
- **Likely cause** (unverified): an ad-blocker extension or a browser privacy mode blocking Google analytics-adjacent endpoints.
- **To verify:** reproduce with/without extensions, inspect network panel, check `gen_204` request's actual failure reason (blocked vs refused vs aborted).

### 3. fetch error: `GET /streets …` → `Failed to fetch` — ERROR
- Source: `js/streets.js:13` (`fetchStreets()`). Called from `js/area-scan.js:366` via `startAreaScan()` on map mouseup.
- `Failed to fetch` is a TypeError from the browser: **network-level failure**, not a 4xx/5xx. Caller (`fetchStreets`) only does `if (!response.ok)` which never runs on network errors — the TypeError propagates up.
- At **14:34:46**, I confirmed the backend `/health` returned ok and `/streets` with the same bounds returned valid JSON. So the backend is reachable **now**.
- **Plausible causes (unverified, pick your own adventure):**
  a. Backend wasn't fully up when the user drew the rectangle. start-stack.sh waits for `/health` but `/streets` depends on `backend/data/streets.db` — if that DB is missing, the endpoint may hang or 500.
  b. The user's browser hit the endpoint during a backend auto-reload (uvicorn `--reload` is enabled in `scripts/start-stack.sh:111`).
  c. CORS preflight failure (the current `fetch` uses no special headers, so this is unlikely but possible).
- **Next steps for the worker:**
  - Check `logs/backend.log` around 14:34:46 for requests to `/streets`. If none, the request never reached the server — likely timing (a) or (b).
  - Check whether `backend/data/streets.db` exists (start-stack.sh:13 warns but does not fail without it).
  - Consider whether `fetchStreets` should surface the failure to the UI or retry, rather than just bubbling the TypeError up into whoever called it. Currently the user sees nothing; the error only appears in logs.
  - If reproducible, add a specific check for network failures in `js/streets.js:13` and emit a clearer log (e.g., `log.error('streets backend unreachable', …)`).

## Files of interest
- `js/logger.js` — how errors get captured (fetch/XHR wrappers, capture-phase resource errors)
- `js/streets.js:11-20` — `fetchStreets` caller of the failing endpoint
- `js/area-scan.js:366` — the call site that triggered the fetch
- `serve.js` — `/__logs` POST handler appending to `logs/browser.log`
- `scripts/start-stack.sh:111` — uvicorn `--reload` setup (potential source of transient unavailability)
- `logs/backend.log` — correlate with the fetch error timestamp

## Not yet investigated
- Whether the same user session produced any other errors the logger caught but flushed after page close (the logs above only span the session captured so far).
- Whether `gen_204` failure correlates with any downstream Maps JS functionality being degraded (pano load, tile rendering).
