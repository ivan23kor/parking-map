# Crop Vertical Offset Investigation

## Problem

The saved cropped area (and preview) appears **higher** than the detected bounding box: the crop includes excessive content above the sign and cuts off or crowds the bottom. The bounding box correctly encloses the sign.

## Pipeline Overview

```
Detection (backend)                    Crop (frontend)
─────────────────                     ───────────────
Static API image                      Tile API (equirectangular)
  (perspective, 640×640)                 (zoom 5, 512px tiles)
       │                                        │
       ▼                                        │
YOLO bbox (x1,y1,x2,y2)                         │
       │                                        │
       ▼                                        │
pixel_to_angular(cx,cy)  ──────────────────────┤
  → (heading, pitch)     world coords            │
       │                                        │
       │              buildDetectionCropPlan     │
       │                    │                   │
       │                    ▼                   │
       │         headingPitchToPixelCorrected   │
       │           (heading, pitch, tilt)       │
       │                    │                   │
       │                    ▼                   │
       └──────────────► tile pixel (x,y)        │
                              │                 │
                              ▼                 │
                       getTilesForRegion        │
                         center at (x,y)       │
                         + CROP_PADDING_Y      │
                              │                 │
                              ▼                 │
                       crop-sign-tiles API ────┘
```

## Potential Root Causes

### 1. **Static API vs Tiles API Coordinate Mismatch**

- **Detection** uses the Street View **Static API** (`/maps/api/streetview`) — perspective images with `heading`, `pitch`, `fov`.
- **Crop** uses the **Tiles API** (`tile.googleapis.com/v1/streetview/tiles/5/...`) — raw equirectangular tiles.
- Both represent the same pano, but the mapping from world (heading, pitch) to pixel coordinates may differ:
  - Static API may apply its own camera model (e.g. different tilt or horizon).
  - Tiles are "stabilized" equirectangular; the tilt correction in `headingPitchToPixelCorrected` assumes a specific model.
- **Hypothesis**: The Static API’s effective pitch for a given world direction does not match the tile coordinate system.

### 2. **Tilt Correction Direction or Magnitude**

`headingPitchToPixelCorrected` applies:

```js
yCorrection = tiltOffset * cos(relH) * (imageHeight / 180)
y = yBase + yCorrection
```

- `tiltOffset = tilt - 90` (positive when camera looks down).
- If the formula is wrong (sign, scaling, or `cos(relH)` usage), the crop center will be shifted vertically.
- **Hypothesis**: The tilt correction pushes the center upward when it should push it down (or vice versa), or the metadata `tilt` is not the same as what the tiles use.

### 3. **Geometric vs Visual Center of the Sign**

- The detection center is the **geometric center** of the bbox `(cx, cy)`.
- Parking signs often have more visual weight at the bottom (e.g. red band, arrows).
- `CROP_PITCH_BIAS_DOWN = 0.12` shifts the center down by 12% of `angularHeight`; this may be insufficient.
- **Hypothesis**: A larger bias (e.g. 20–25%) or a bias that depends on sign aspect ratio is needed.

### 4. **Preview View vs Detection View Mismatch**

- The popup preview uses `choosePreviewViewForSign`, which can pick a **refined** view from a different panorama or slice.
- If the refined detection has different `(heading, pitch)` or comes from a different pano, the crop will be computed for that view, not the one the user is looking at.
- **Hypothesis**: The preview is built from a different detection than the one whose bbox is shown in the main view.

### 5. **angularHeight Underestimation**

- `angularHeight` is computed from the bbox corners in the backend.
- If it is underestimated, `signSize.height` is smaller, so the crop height is smaller.
- The crop **center** would still be correct; only the extent would change.
- **Hypothesis**: Less likely to explain “crop too high” unless the center is also affected by a bug.

### 6. **Metadata (panoHeading, tilt) Staleness or Incorrectness**

- `buildDetectionCropPlan` fetches metadata once per pano.
- If metadata is cached incorrectly or the Tiles metadata API returns values that don’t match the tiles, the conversion will be wrong.
- **Hypothesis**: `tilt` or `heading` from metadata does not match the actual tile orientation.

---

## Proposed Instrumentation

### A. Console Logging in `buildDetectionCropPlan` (already partially present)

Extend the existing `console.log` block to include:

- `det.pitch` (raw) vs `cropPitch` (after bias)
- `pitchBias` in degrees
- `uncorrected.y` vs `corrected.y` and `yCorrection`
- `cropBounds.y` and `cropBounds.height`
- For comparison: pixel y for the **top** and **bottom** of the bbox if we had them in tile space (see B)

### B. Back-project Bbox Edges to Tile Space

Add a helper that, given a detection’s `(heading, pitch, angularHeight)`, computes the tile y for:

- Top of bbox: `pitch + angularHeight/2`
- Bottom of bbox: `pitch - angularHeight/2`
- Center: `pitch`

Log these and compare to `corrected.y`. This shows whether the crop center lies within the angular bbox in tile space.

### C. Debug Overlay on Saved Crop

When `debug: true` (already passed for save), extend the backend to draw:

1. **Yellow crosshair** at crop center (current behavior).
2. **Cyan crosshair** at the position that would correspond to `pitch - CROP_PITCH_BIAS_DOWN * angularHeight` (i.e. “unbiased” center).
3. **Green rectangle** approximating where the bbox would project in the crop (using angular width/height and assuming the center is correct).

This gives a visual check of center vs bbox in the saved image.

### D. Tilt Correction Sanity Check

Log and optionally expose in the UI:

- `metadata.tilt`, `metadata.heading`
- `relH` (relative heading)
- `yCorrection` in pixels and as a fraction of crop height
- Compare `uncorrected` vs `corrected` y for a few detections to see if the correction moves the center in the expected direction.

### E. Compare Static API vs Tile at Same (heading, pitch)

Create a small debug endpoint or script that:

1. Fetches a Static API image at `(pano, heading, pitch, fov)`.
2. Fetches the corresponding tile region.
3. For a known point (e.g. image center), computes its (heading, pitch) from the Static API and from the tile.
4. Reports any discrepancy.

### F. A/B Test Pitch Bias

Temporarily add a query param or UI control to vary `CROP_PITCH_BIAS_DOWN` (e.g. 0, 0.12, 0.20, 0.25) and save crops for the same detection. Compare which value best centers the sign.

---

## Recommended Order

1. **A + D** — Minimal logging to inspect pitch, bias, and tilt correction.
2. **B** — Verify that the crop center falls within the angular bbox in tile space.
3. **C** — Visual confirmation on the saved crop.
4. **F** — Empirical tuning of the pitch bias.
5. **E** — Deeper check of Static vs Tile coordinate alignment if the above do not explain the offset.

---

## Files to Instrument

| Location | Purpose |
|---------|---------|
| `js/detection.js` `buildDetectionCropPlan` | Log pitch, bias, uncorrected/corrected y, cropBounds |
| `js/detection.js` | Add `debugBboxProjection(det, corrected)` helper |
| `backend/main.py` `crop_sign_tiles` | Extend debug overlay (second crosshair, bbox outline) |
| `js/streetview.js` or `js/detection.js` | Log metadata.tilt, metadata.heading when fetching |
