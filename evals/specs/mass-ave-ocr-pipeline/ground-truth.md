# Ground Truth: mass-ave-ocr-pipeline

## Visual assertions
- Panorama pane shows real Street View imagery (not black/empty) at each of the 3 points
- Detection bounding boxes appear on the panorama overlay after each detection run
- OCR labels appear below detection boxes after OCR completes (e.g., "NO PARKING", "TOW ZONE")
- Sign markers (green dots) appear on the 2D map at projected sign locations
- Rule curves (colored polylines) render along street centerlines corresponding to detected sign rules

## Structural assertions
- At least 1 sign detected across all 3 panorama points (otherwise the eval is inconclusive)
- Every detection cluster has an `ocrResult` (no undefined/null)
- Every `ocrResult` has `is_parking_sign` field (boolean)
- For signs where `is_parking_sign` is true: `rules` array exists and has at least 1 rule
- Each rule has a `category` field (one of: no_parking, parking_allowed, loading_zone, permit_required)
- Sign map data in localStorage accumulates across all 3 points (detectionCount >= 3, one per pano point)
- Each detection in sign map data has `signs` array with at least 0 signs
- Rule curves layer has at least 1 polyline after all 3 detections complete

## Screenshot assertions
- **01-app-loaded.png**: Split view visible — left pane black (no panorama yet), right pane shows OSM map centered on Cambridge area
- **02-pano-point-1.png**: Panorama loaded with Street View imagery, detectionStatus shows heading info
- **03-point1-detection-complete.png**: Detection boxes visible on panorama, green sign markers on map, status shows detection count
- **04-pano-point-2.png**: New panorama loaded at second point
- **05-point2-detection-complete.png**: More detections visible, additional sign markers and rule curves on map
- **06-pano-point-3.png**: Third panorama loaded
- **07-point3-detection-complete.png**: Full detection state, accumulated markers/curves visible
- **08-final-state.png**: Complete map state with all 3 detection points, accumulated sign markers and rule curves

## Error assertions
- Zero console errors throughout the entire eval
- Zero 4XX or 5XX network responses
- Any error = eval FAIL immediately

## Notes
- **Ground truth for OCR content (specific rules, categories, times) is TBD.** The user will define expected rules after reviewing the eval output from the first run.
- Some panorama points may have 0 detections — this is valid. The eval should still complete without errors.

## Visual timeline assertions
- Visual timeline assertions are auto-generated from change screenshots. No explicit timeline assertions specified at this time.
