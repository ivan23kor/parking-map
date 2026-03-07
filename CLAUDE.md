# AGENTS.md

This file provides guidance when working with code in this repository.

## Repo at a glance
Three main parts:
1. **Static map/panorama viewers** (`index.html`, `ui-map/`, `ui-panorama/`): Leaflet + Turf + Google Maps JS API with modular JS in `js/`
2. **Next.js upload UI** (`ui-upload/`): shadcn/ui component library for uploading/detecting parking signs
3. **Parking-sign ML backend** (`backend/`): FastAPI YOLO11 detection service + training pipeline (`datasets/`, `notebooks/`)

## Common commands
### Run static app locally
- Serve repo root on `http://localhost:8080` (injects `GOOGLE_MAPS_API_KEY` from env):
  ```bash
  npm run serve
  # or
  node serve.js
  ```

- Serve Python version:
  ```bash
  python3 serve.py
  ```

### Build Next.js upload UI
```bash
npm run build    # Builds ui-upload/ to ui-upload/out/
```

### Build ML training dataset
```bash
python3 datasets/build_unified_dataset.py
```
Expects source datasets under `datasets/` (gitignored, local-only). Writes to `datasets/parking-sign-detection-coco-dataset/`.

### Run detection backend
```bash
# With uv (preferred):
uv venv && uv pip install --python .venv/bin/python -r backend/requirements.txt
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# Or with venv/pip:
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

### Train on Kaggle
1. Upload `datasets/parking-sign-detection-coco-dataset/` to kaggle.com/datasets
2. Import notebook from `notebooks/`
3. Enable GPU, run

See `notebooks/EXPERIMENT_7_README.md` for latest experiment details.

## Architecture (big picture)
### 1) Static web app (`index.html`, `ui-map/`, `ui-panorama/`)
Modular vanilla JS apps.

**File structure:**
```
config.js           # Google API key + detection API config
js/
├── utils.js        # Progress bar, error display
├── streets.js      # Overpass API, street sampling with turf.bearing()
├── panorama.js     # Shared panorama config (pitch, zoom, heading offset)
├── streetview.js   # Session tokens, panoIds bulk fetch, panorama display
└── detection.js    # YOLO detection API calls, bounding box rendering
ui-map/
└── index.html      # Map-based UI with area selection
ui-panorama/
└── index.html      # Single panorama UI (Calgary Tower demo)
```

**Key pieces:**
- **Map rendering:** Leaflet + OpenStreetMap tiles
- **Selection workflow:** draw rectangle (button or Ctrl/⌘ drag) → fetch streets → check Street View coverage
- **External APIs:**
  - Overpass API (`https://overpass-api.de/api/interpreter`) — OSM streets in bbox
  - Google Map Tiles API (`https://tile.googleapis.com/v1/streetview/panoIds`) — bulk panoId fetch (100 per request)
  - Google Maps JS API (`StreetViewPanorama`) — panorama display
- **Layers:** `streetsLayer`, `streetViewDotsLayer`, `selectionLayer` (Leaflet LayerGroups)
- **Driver perspective:** `panorama.js` shared config. Heading = base direction ± 45° (right/left via `calculateHeadingWithSide()`), handles OSM `oneway` tag. Default pitch = 0.

**Config coupling:**
- `config.js` exports `window.GOOGLE_CONFIG.API_KEY` and `window.DETECTION_CONFIG`
- Session tokens cached in `localStorage` (~13 days)

### 2) Next.js upload UI (`ui-upload/`)
shadcn/ui component library for uploading/detecting parking signs.

**Build/run:**
```bash
cd ui-upload && bun install && bun run build
```

### 3) Detection backend (`backend/`)
FastAPI service running YOLO11 inference on Street View images.

**API endpoints:**
- `GET /health` — Health check
- `POST /detect` — Run detection on image URL
  - Request: `{"image_url": "...", "confidence": 0.15}`
  - Response: `{"detections": [{"x1", "y1", "x2", "y2", "confidence", "class_name"}], "inference_time_ms": ...}`
- `POST /detect-sahi` — Slicing Aided Hyper Inference (overlapping higher-zoom windows)
- `POST /crop-sign-tiles` — Fetch/stitch/crop Street View tiles at max zoom
- `POST /preview-sign` — Fetch sign-centered Street View at tight FOV
- `GET /detect-debug` — Return image with bounding boxes drawn

**Model:** Download from Kaggle → `backend/models/best.pt` (YOLO11m, 1 class: `parking_sign`)

**Detected signs:** Saved to `detected_signs/`, served at `/detected-signs/`

### 4) ML/training (`datasets/`, `notebooks/`)
Data flow:
- Raw datasets in `datasets/` → `build_unified_dataset.py` → single-class YOLO dataset (512x512) with `data.yaml`
- Training notebooks in `notebooks/` (numbered for experiment tracking)
- See `notebooks/EXPERIMENT_7_README.md` for latest experiment details

## Sharp edges / mismatches
- `package.json` references `src/index.html` but actual source is `index.html` at repo root (no `src/` dir)
- `run-sign-detector.sh` and `start-sign-detector.sh` expect `sign-detector/` subdirectory that doesn't exist in current repo structure
- Detection requires backend on `http://localhost:8000` — UI gracefully degrades without it
- Training is on Kaggle, not locally — no Docker setup currently in use
