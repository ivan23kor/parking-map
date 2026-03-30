# Ground Truth: rule-curve-intersections

## Structural assertions

### Intersections detected
- `intersections.intersectionCount` must be >= 2 (Vassar Street has at least 2 cross-street intersections in the fixture area)
- `intersections.intersectionNodeIndices` must be a non-empty array

### Rule curves rendered
- `ruleCurves` array must contain at least 1 curve
- Each curve must have `pointCount` >= 3 (a curve is a polyline, not a point or single segment)
- Each curve length must be > 8m (not degenerate)
- Every curve color must be one of the known palette values (no unknown colors):
  - `#ef4444` — no_parking (red)
  - `#22c55e` — parking_allowed (green)
  - `#8b5cf6` — loading_zone (purple)
  - `#f59e0b` — permit_required (amber)
  - `#dc2626` — tow zone overlay (dashed red)
- Multiple curves per direction are valid — a sign can produce stacked overlays (e.g. loading_zone + tow zone, or no_parking + tow zone)

### Distance calculation
- `maxDistForward` (or equivalent) must be > 10 (meaningful distance to next intersection)
- `maxDistBackward` (or equivalent) must be > 10

### Sign markers present
- `sign_markers` must contain at least one entry with `fillColor` "#22c55e" (green sign dot)
- `sign_markers` must contain at least one entry with `fillColor` "#60a5fa" (blue camera dot)
- `sign_markers` must contain at least one entry with `dashArray` "10 8" and `color` "#f59e0b" (amber dashed road centerline)

## Visual assertions

### Rule curve appearance
- Rule curves must be visible as colored polylines on the map
- Rule curves must extend to the nearest intersection in each direction (not a fixed fallback distance)
- When multiple rules apply to the same direction, their curves stack visually as parallel overlays

## Screenshot assertions

### 02-final-rule-curves.png
- A map should be visible with colored polylines (rule curves) distinct from street lines
- Rule curves should appear offset from the street centerline, running parallel to it
- Colored dots visible on the map (green sign dot, blue camera dot)

## Console assertions
- `console_errors` must be empty (no JavaScript errors during rendering)
- `console_logs` must contain at least one entry matching "renderRuleCurves" (confirming the rule curve rendering code executed)
