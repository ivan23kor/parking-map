# Inspector: mass-ave-ocr-pipeline

## Setup
- Start the app: `GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY GEMINI_API_KEY=$GEMINI_API_KEY bun run start`
- Open: `http://localhost:3000`
- Fail fast if `GOOGLE_MAPS_API_KEY` or `GEMINI_API_KEY` not set
- Fail on ANY console error, 429, 5XX, or network error — no tolerance
- No fixture loading. No mocking. Real services only (backend, Google Street View, Gemini OCR)
- Clear localStorage before starting: `localStorage.removeItem('parksight_latest_sign_map_data')`

## Pano points

Three panorama points on Mass Ave between Landsdowne St and Windsor St, Cambridge MA, heading north (0°):

| Point | Lat | Lng | Heading |
|-------|-----|-----|---------|
| 1 | 42.36103 | -71.0960 | 0 |
| 2 | 42.36103 | -71.0948 | 0 |
| 3 | 42.36103 | -71.0938 | 0 |

## Steps

### 1. Load app and clear state
```js
await page.evaluate(() => localStorage.removeItem('parksight_latest_sign_map_data'));
await page.reload({ waitUntil: 'networkidle' });
```
Capture: screenshot `01-app-loaded.png`

### 2. Navigate to pano point 1
Click on the map at coordinates [42.36103, -71.0960] to trigger Street View lookup and panorama loading.

```js
await page.evaluate((latlng) => {
  const map = document.querySelector('#map')?._leaflet_map || window.map;
  if (map) map.fire('click', { latlng: L.latLng(latlng[0], latlng[1]) });
}, [42.36103, -71.0960]);
```

Wait for panorama to load (detectionStatus text changes from "Finding nearest Street View..." to contain "Heading").

Capture: screenshot `02-pano-point-1.png`

### 3. Run detection on point 1
Click "Detect (single)" button.

```js
await page.click('#detectSingleBtn');
```

Wait for:
- Detection to complete: `currentDetections` has length > 0
- OCR to finish: listen for `ocr-complete` event or wait until all detections have `ocrResult`

```js
// Wait for detection + OCR to complete
await page.waitForFunction(() => {
  return window.currentDetections?.length > 0 &&
    window.currentDetections.every(d => d.ocrResult !== undefined);
}, { timeout: 120000 });
```

Extract OCR results for point 1:
```js
const point1Results = await page.evaluate(() => {
  return window.currentDetections.map((det, i) => ({
    index: i,
    heading: det.heading,
    pitch: det.pitch,
    confidence: det.confidence,
    ocrResult: det.ocrResult ? {
      is_parking_sign: det.ocrResult.is_parking_sign,
      confidence_readable: det.ocrResult.confidence_readable,
      rules: det.ocrResult.rules,
      tow_zones: det.ocrResult.tow_zones,
      raw_text: det.ocrResult.raw_text,
      rejection_reason: det.ocrResult.rejection_reason,
    } : null,
  }));
});
```

Extract sign map data for point 1:
```js
const signMapData1 = await page.evaluate(() => {
  const raw = localStorage.getItem('parksight_latest_sign_map_data');
  return raw ? JSON.parse(raw) : null;
});
```

Capture: screenshot `03-point1-detection-complete.png`

### 4. Navigate to pano point 2
Click on map at [42.36103, -71.0948].

```js
await page.evaluate((latlng) => {
  const map = document.querySelector('#map')?._leaflet_map || window.map;
  if (map) map.fire('click', { latlng: L.latLng(latlng[0], latlng[1]) });
}, [42.36103, -71.0948]);
```

Wait for panorama to load.

Capture: screenshot `04-pano-point-2.png`

### 5. Run detection on point 2
```js
await page.click('#detectSingleBtn');
await page.waitForFunction(() => {
  return window.currentDetections?.length > 0 &&
    window.currentDetections.every(d => d.ocrResult !== undefined);
}, { timeout: 120000 });
```

Extract OCR results for point 2:
```js
const point2Results = await page.evaluate(() => {
  return window.currentDetections.map((det, i) => ({
    index: i,
    heading: det.heading,
    pitch: det.pitch,
    confidence: det.confidence,
    ocrResult: det.ocrResult ? {
      is_parking_sign: det.ocrResult.is_parking_sign,
      confidence_readable: det.ocrResult.confidence_readable,
      rules: det.ocrResult.rules,
      tow_zones: det.ocrResult.tow_zones,
      raw_text: det.ocrResult.raw_text,
      rejection_reason: det.ocrResult.rejection_reason,
    } : null,
  }));
});
```

Capture: screenshot `05-point2-detection-complete.png`

### 6. Navigate to pano point 3
Click on map at [42.36103, -71.0938].

```js
await page.evaluate((latlng) => {
  const map = document.querySelector('#map')?._leaflet_map || window.map;
  if (map) map.fire('click', { latlng: L.latLng(latlng[0], latlng[1]) });
}, [42.36103, -71.0938]);
```

Wait for panorama to load.

Capture: screenshot `06-pano-point-3.png`

### 7. Run detection on point 3
```js
await page.click('#detectSingleBtn');
await page.waitForFunction(() => {
  return window.currentDetections?.length > 0 &&
    window.currentDetections.every(d => d.ocrResult !== undefined);
}, { timeout: 120000 });
```

Extract OCR results for point 3:
```js
const point3Results = await page.evaluate(() => {
  return window.currentDetections.map((det, i) => ({
    index: i,
    heading: det.heading,
    pitch: det.pitch,
    confidence: det.confidence,
    ocrResult: det.ocrResult ? {
      is_parking_sign: det.ocrResult.is_parking_sign,
      confidence_readable: det.ocrResult.confidence_readable,
      rules: det.ocrResult.rules,
      tow_zones: det.ocrResult.tow_zones,
      raw_text: det.ocrResult.raw_text,
      rejection_reason: det.ocrResult.rejection_reason,
    } : null,
  }));
});
```

Capture: screenshot `07-point3-detection-complete.png`

### 8. Extract final accumulated state
After all 3 points, extract the full accumulated sign map data including all detections, signs, and rule curves.

```js
const finalSignMapData = await page.evaluate(() => {
  const raw = localStorage.getItem('parksight_latest_sign_map_data');
  const data = raw ? JSON.parse(raw) : null;
  return {
    savedAt: data?.savedAt,
    source: data?.source,
    detectionCount: data?.detections?.length,
    detections: data?.detections?.map(d => ({
      panoId: d.panoId,
      cameraLat: d.camera?.lat,
      cameraLng: d.camera?.lon,
      signCount: d.signs?.length,
      signs: d.signs?.map(s => ({
        lat: s.lat,
        lon: s.lon,
        heading: s.heading,
        distance: s.distance,
        ocrResult: s.ocrResult ? {
          is_parking_sign: s.ocrResult.is_parking_sign,
          rules: s.ocrResult.rules?.map(r => ({
            category: r.category,
            arrow_direction: r.arrow_direction,
            days: r.days,
            time_start: r.time_start,
            time_end: r.time_end,
            time_limit_minutes: r.time_limit_minutes,
          })),
          tow_zones: s.ocrResult.tow_zones,
          raw_text: s.ocrResult.raw_text,
        } : null,
      })),
    })),
  };
});
```

Extract rule curves from the map:
```js
const ruleCurveData = await page.evaluate(() => {
  // Check if ruleCurvesLayer has polylines
  const curves = [];
  if (window.ruleCurvesLayer) {
    window.ruleCurvesLayer.eachLayer(layer => {
      if (layer.getLatLngs) {
        curves.push({
          latLngs: layer.getLatLngs().map(ll => [ll.lat, ll.lng]),
          color: layer.options?.color,
          dashArray: layer.options?.dashArray,
          weight: layer.options?.weight,
        });
      }
    });
  }
  return { curveCount: curves.length, curves };
});
```

Extract console errors:
```js
// Collected throughout the test via page.on('console')
// Report any errors or warnings
```

Capture: screenshot `08-final-state.png`

## Console error capture
```js
const consoleErrors = [];
page.on('console', msg => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleErrors.push({ type: msg.type(), text: msg.text() });
  }
});

// Also fail on network errors (429, 5XX)
page.on('response', response => {
  if (response.status() >= 400) {
    consoleErrors.push({ type: 'network_error', text: `${response.status()} ${response.url()}` });
  }
});
```
