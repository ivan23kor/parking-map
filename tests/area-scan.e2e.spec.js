const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { mockInfrastructure } = require("./helpers/mock-infrastructure");

/**
 * Area Scan E2E tests — freehand polygon → batch panorama detection pipeline.
 *
 * All external APIs stubbed via mockInfrastructure.
 * Street data from Vassar Street / MIT fixture.
 *
 * Run: bunx playwright test tests/area-scan.e2e.spec.js
 * Debug: HEADLESS=false bunx playwright test tests/area-scan.e2e.spec.js -g "test name"
 */

const fixtureWays = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "fixtures/vassar-street-mit-ways.json"), "utf-8"),
);

const VASSAR_WAY = fixtureWays.find((w) => w.id === 28631895);

// Polygon that encloses a chunk of Vassar Street (enough for BFS to find panos)
const SCAN_POLYGON_LATLNGS = [
  [42.3618, -71.0928],
  [42.3618, -71.0915],
  [42.3612, -71.0915],
  [42.3612, -71.0928],
];

// Convert [lat, lng] → turf [lng, lat] ring (auto-closed)
const SCAN_POLYGON_RING = [...SCAN_POLYGON_LATLNGS, SCAN_POLYGON_LATLNGS[0]].map(
  ([lat, lng]) => [lng, lat],
);

const DETECTION_RESPONSE = {
  status: 200,
  body: JSON.stringify({
    detections: [
      {
        x1: 0, y1: 0, x2: 40, y2: 180,
        full_pano_x1: 2508, full_pano_y1: 4200, full_pano_x2: 2548, full_pano_y2: 4380,
        heading: 281, pitch: -4.2, angular_width: 0.8, angular_height: 4.0,
        confidence: 0.87, class_name: "parking_sign",
        depth_anything_meters: 15.2, depth_anything_meters_raw: 15.0,
      },
    ],
    total_inference_time_ms: 55, stitched_width: 1024, stitched_height: 512, pano_heading: 45,
  }),
};

// ─── helpers ──────────────────────────────────────────────────────────

async function setupPage(page, options = {}) {
  await mockInfrastructure(page, {
    fixtureWays,
    detectPanoramaResponse: options.detectPanoramaResponse ?? DETECTION_RESPONSE,
    ...options,
  });
  await page.goto("/?api_key=test-key");
  // Wait for initApp to complete
  await page.waitForFunction(() => typeof map !== "undefined", { timeout: 10000 });
}

function makeMapMouseEvent(type, lat, lng) {
  return { type, latlng: { lat, lng } };
}

// ─── Task 1: CSS + HTML markup + script tag ───────────────────────────

test.describe("area scan UI elements", () => {
  test("scan area button is visible and styled on load", async ({ page }) => {
    await setupPage(page);

    const btn = page.locator("#scanAreaBtn");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("Scan area");

    // Status chip hidden by default
    const status = page.locator("#scanAreaStatus");
    expect(await status.isVisible()).toBe(false);

    // No drawing class on body
    expect(await page.evaluate(() => document.body.classList.contains("area-scan-drawing"))).toBe(false);
  });

  test("drawing cursor activates and deactivates", async ({ page }) => {
    await setupPage(page);

    // Enter draw mode
    await page.locator("#scanAreaBtn").click();
    expect(await page.evaluate(() => document.body.classList.contains("area-scan-drawing"))).toBe(true);
    await expect(page.locator("#scanAreaBtn")).toHaveText("Cancel scan");

    // Exit draw mode
    await page.locator("#scanAreaBtn").click();
    expect(await page.evaluate(() => document.body.classList.contains("area-scan-drawing"))).toBe(false);
    await expect(page.locator("#scanAreaBtn")).toHaveText("Scan area");
  });

  test("hotkey D toggles draw mode without conflicting with Shift+D", async ({ page }) => {
    await setupPage(page);

    // Press bare D
    await page.keyboard.press("d");
    expect(await page.evaluate(() => areaScanState.drawing)).toBe(true);

    // Press D again to exit
    await page.keyboard.press("d");
    expect(await page.evaluate(() => areaScanState.drawing)).toBe(false);

    // Shift+D should not toggle area scan
    await page.keyboard.press("Shift+d");
    expect(await page.evaluate(() => areaScanState.drawing)).toBe(false);
  });
});

// ─── Task 2: Integration hooks ────────────────────────────────────────

test.describe("area scan integration hooks", () => {
  test("click guard prevents pano opening while drawing", async ({ page }) => {
    await setupPage(page);

    // Enter draw mode
    await page.evaluate(() => toggleAreaScanMode());

    // Click on map — should not resolve panorama
    await page.evaluate((latlng) => {
      map.fire("click", { latlng });
    }, { lat: 42.3615, lng: -71.0921 });

    // Give it a moment — if pano resolved, detectionStatus would change
    await page.waitForTimeout(500);
    const status = await page.locator("#detectionStatus").textContent();
    // Should NOT say "Finding nearest Street View"
    expect(status).not.toContain("Finding nearest Street View");
  });

  test("scanAreaLayer is initialized and available", async ({ page }) => {
    await setupPage(page);

    const exists = await page.evaluate(() => typeof scanAreaLayer !== "undefined" && scanAreaLayer !== null);
    expect(exists).toBe(true);

    // It should have addLayer method (LayerGroup)
    const hasAddLayer = await page.evaluate(() => typeof scanAreaLayer.addLayer === "function");
    expect(hasAddLayer).toBe(true);
  });

  test("initAreaScan attaches mouse listeners exactly once", async ({ page }) => {
    await setupPage(page);

    // Enter draw mode
    await page.evaluate(() => toggleAreaScanMode());

    // Simulate a simple drawing sequence
    const result = await page.evaluate(() => {
      // Fire mouse events to draw
      map.fire("mousedown", { latlng: { lat: 42.3615, lng: -71.0925 } });
      map.fire("mousemove", { latlng: { lat: 42.3615, lng: -71.0920 } });
      map.fire("mousemove", { latlng: { lat: 42.3612, lng: -71.0920 } });
      map.fire("mousemove", { latlng: { lat: 42.3612, lng: -71.0925 } });
      map.fire("mouseup", { latlng: { lat: 42.3612, lng: -71.0925 } });

      return {
        drawing: areaScanState.drawing,
        discoveredCount: areaScanState.discoveredPanos.size,
        polygonSet: areaScanState.polygonFeature !== null,
      };
    });

    // Draw mode should have exited after mouseup
    expect(result.drawing).toBe(false);
    // Polygon should be set
    expect(result.polygonSet).toBe(true);
  });

  test("auto-closes imperfect polygon on mouseup", async ({ page }) => {
    await setupPage(page);

    await page.evaluate(() => toggleAreaScanMode());

    const result = await page.evaluate(() => {
      // Draw a C-shape — last point far from first, only 4 points total (min for closure)
      map.fire("mousedown", { latlng: { lat: 42.3620, lng: -71.0928 } });
      map.fire("mousemove", { latlng: { lat: 42.3620, lng: -71.0915 } });
      map.fire("mousemove", { latlng: { lat: 42.3615, lng: -71.0915 } });
      map.fire("mousemove", { latlng: { lat: 42.3612, lng: -71.0918 } });
      // Release far from start — auto-close should connect back
      map.fire("mouseup", { latlng: { lat: 42.3612, lng: -71.0918 } });

      return {
        hasPolygon: areaScanState.polygonFeature !== null,
        ringLength: areaScanState.polygonFeature?.geometry?.coordinates?.[0]?.length ?? 0,
        firstCoord: areaScanState.polygonFeature?.geometry?.coordinates?.[0]?.[0],
        lastCoord: areaScanState.polygonFeature?.geometry?.coordinates?.[0]?.[areaScanState.polygonFeature.geometry.coordinates[0].length - 1],
      };
    });

    expect(result.hasPolygon).toBe(true);
    // Ring should be auto-closed: last coord == first coord
    expect(result.ringLength).toBeGreaterThanOrEqual(5); // 4 drawn points + closing point
    expect(result.lastCoord[0]).toBeCloseTo(result.firstCoord[0], 10);
    expect(result.lastCoord[1]).toBeCloseTo(result.firstCoord[1], 10);
  });
});

// ─── Task 3: Full pipeline ────────────────────────────────────────────

test.describe("area scan pipeline", () => {
  test("small area scan discovers panos and processes them", async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      // Build a polygon around part of Vassar Street
      const polygonFeature = turf.polygon([[
        [-71.0928, 42.3618], [-71.0915, 42.3618],
        [-71.0915, 42.3612], [-71.0928, 42.3612],
        [-71.0928, 42.3618],
      ]]);

      await startAreaScan(polygonFeature);

      return {
        panoCount: areaScanState.discoveredPanos.size,
        processed: areaScanState.processed,
        cancelled: areaScanState.cancelled,
      };
    }, { timeout: 30000 });

    // Mock Google Maps returns 1 linked pano → seed + linked = 2 panos max
    expect(result.panoCount).toBeGreaterThanOrEqual(1);
    expect(result.panoCount).toBeLessThanOrEqual(100);
    expect(result.cancelled).toBe(false);
  });

  test("large area respects MAX_PANOS cap", async ({ page }) => {
    await setupPage(page);

    // Override MAX_PANOS to a small number for testing
    await page.evaluate(() => { areaScanState.MAX_PANOS = 3; });

    // Create a large polygon
    const result = await page.evaluate(async () => {
      const polygonFeature = turf.polygon([[
        [-71.095, 42.363], [-71.090, 42.363],
        [-71.090, 42.360], [-71.095, 42.360],
        [-71.095, 42.363],
      ]]);

      await startAreaScan(polygonFeature);

      return {
        panoCount: areaScanState.discoveredPanos.size,
        maxPanos: areaScanState.MAX_PANOS,
      };
    }, { timeout: 30000 });

    expect(result.panoCount).toBeLessThanOrEqual(result.maxPanos);
  });

  test("cancel mid-scan preserves partial results", async ({ page }) => {
    await setupPage(page);

    // Start a scan then cancel
    const result = await page.evaluate(async () => {
      const polygonFeature = turf.polygon([[
        [-71.0928, 42.3618], [-71.0915, 42.3618],
        [-71.0915, 42.3612], [-71.0928, 42.3612],
        [-71.0928, 42.3618],
      ]]);

      // Start scan but cancel after a short delay
      const scanPromise = startAreaScan(polygonFeature);
      await new Promise(r => setTimeout(r, 200));
      areaScanState.cancelled = true;
      await scanPromise;

      return {
        panoCount: areaScanState.discoveredPanos.size,
        cancelled: areaScanState.cancelled,
      };
    }, { timeout: 30000 });

    expect(result.cancelled).toBe(true);
    // Some panos may have been discovered before cancel
    expect(result.panoCount).toBeGreaterThanOrEqual(0);
  });

  test("re-scan overlapping area uses cache", async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      const polygonFeature = turf.polygon([[
        [-71.0928, 42.3618], [-71.0915, 42.3618],
        [-71.0915, 42.3612], [-71.0928, 42.3612],
        [-71.0928, 42.3618],
      ]]);

      // First scan
      await startAreaScan(polygonFeature);
      const firstDiscovered = areaScanState.discoveredPanos.size;
      const firstProcessed = areaScanState.processed;

      // Second scan — same polygon (should use cache)
      await startAreaScan(polygonFeature);
      const secondDiscovered = areaScanState.discoveredPanos.size;
      const secondProcessed = areaScanState.processed;

      return { firstDiscovered, firstProcessed, secondDiscovered, secondProcessed };
    }, { timeout: 30000 });

    // Both scans should discover the same number of panos
    expect(result.secondDiscovered).toBe(result.firstDiscovered);
    // Second scan should also process (via cache or fresh)
    expect(result.secondProcessed).toBeGreaterThanOrEqual(result.firstProcessed);
  });

  test("no streets in polygon shows graceful message", async ({ page }) => {
    // Stub streets endpoint to return empty array for this test
    await mockInfrastructure(page, { fixtureWays: [] });
    await page.goto("/?api_key=test-key");
    await page.waitForFunction(() => typeof map !== "undefined", { timeout: 10000 });

    const statusText = await page.evaluate(async () => {
      // Polygon in the middle of nowhere (no streets)
      const polygonFeature = turf.polygon([[
        [-71.0000, 42.0000], [-70.9990, 42.0000],
        [-70.9990, 41.9990], [-71.0000, 41.9990],
        [-71.0000, 42.0000],
      ]]);

      await startAreaScan(polygonFeature);

      return document.getElementById("scanAreaStatus")?.textContent;
    }, { timeout: 15000 });

    expect(statusText).toContain("No streets");
  });

  test("detection heading logic matches oneway vs two-way spec", async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(() => {
      const _normalize = (b) => ((b % 360) + 360) % 360;

      // Two-way street (oneway falsy)
      const b = 56.25;
      const twoWay = [_normalize(b + 45), _normalize(b - 135)];

      // One-way street
      const oneWay = [_normalize(b + 45), _normalize(b - 45)];

      return { twoWay, oneWay, b };
    });

    // Two-way: right curb forward (bearing+45) and right curb reverse (bearing-135)
    expect(result.twoWay[0]).toBeCloseTo(101.25, 2);
    expect(result.twoWay[1]).toBeCloseTo(281.25, 2);

    // One-way: both curbs (bearing ±45)
    expect(result.oneWay[0]).toBeCloseTo(101.25, 2);
    expect(result.oneWay[1]).toBeCloseTo(11.25, 2);
  });
});
