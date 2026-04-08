#!/usr/bin/env bun
/**
 * Headless panorama walker for tilt offset calibration.
 * Walks all panoramas in a map region, runs sign detections,
 * and records metadata to JSONL for later annotation.
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=... bun scripts/walk-panos.js \
 *     --south 37.785 --west -122.410 --north 37.790 --east -122.405 \
 *     --output calibration-walk.jsonl \
 *     --min-tilt-offset 1.0
 *
 * Requires: backend running on http://127.0.0.1:8000
 */

import { writeFileSync, appendFileSync } from "fs";

const BACKEND_URL = "http://127.0.0.1:8000";
const TILES_API = "https://tile.googleapis.com/v1";
const SIDE_OFFSET = 45; // degrees, same as PANORAMA_DEFAULTS.sideOffset
const PANO_BATCH_SIZE = 100;
const DETECTION_DELAY_MS = 100;
const DETECTION_FOV = 90;
const DETECTION_PITCH = 0;
const DETECTION_IMG_SIZE = 640;
const TILE_GRID_WIDTH = 16384;
const TILE_GRID_HEIGHT = 8192;

// --- CLI parsing (manual to handle negative numbers) ---
function getArg(name, defaultVal) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal;
  return process.argv[idx + 1];
}

const south = parseFloat(getArg("south"));
const west = parseFloat(getArg("west"));
const north = parseFloat(getArg("north"));
const east = parseFloat(getArg("east"));
const outputFile = getArg("output", "calibration-walk.jsonl");
const interval = parseFloat(getArg("interval", "50"));
const confidence = parseFloat(getArg("confidence", "0.15"));
const minTiltOffset = parseFloat(getArg("min-tilt-offset", "0"));

if ([south, west, north, east].some(Number.isNaN)) {
  console.error("Usage: bun scripts/walk-panos.js --south S --west W --north N --east E [--output FILE] [--min-tilt-offset N]");
  process.exit(1);
}

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  console.error("Error: GOOGLE_MAPS_API_KEY environment variable is required");
  process.exit(1);
}

function log(...args) {
  console.error(...args);
}

// --- Equirectangular projection helpers ---

function headingPitchToPixelCorrected(heading, pitch, imageWidth, imageHeight, panoHeading, tilt) {
  const deg2rad = Math.PI / 180;
  const rad2deg = 180 / Math.PI;

  const hRad = heading * deg2rad;
  const pRad = pitch * deg2rad;
  const cosP = Math.cos(pRad);
  const dx = cosP * Math.sin(hRad);
  const dy = cosP * Math.cos(hRad);
  const dz = Math.sin(pRad);

  const phRad = panoHeading * deg2rad;
  const cosPh = Math.cos(phRad);
  const sinPh = Math.sin(phRad);
  const localX = dx * cosPh - dy * sinPh;
  const localY = dx * sinPh + dy * cosPh;
  const localZ = dz;

  const alpha = (tilt - 90) * deg2rad;
  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);
  const stabX = localX;
  const stabY = cosA * localY + sinA * localZ;
  const stabZ = -sinA * localY + cosA * localZ;

  const stabRelHDeg = Math.atan2(stabX, stabY) * rad2deg;
  const stabPitchDeg = Math.asin(Math.max(-1, Math.min(1, stabZ))) * rad2deg;

  const x = ((stabRelHDeg + 180) / 360) * imageWidth;
  const y = ((90 - stabPitchDeg) / 180) * imageHeight;

  const yBase = ((90 - pitch) / 180) * imageHeight;
  const yCorrection = y - yBase;

  return { x, y, yCorrection };
}

// --- Google Map Tiles API helpers ---

async function createSession() {
  const resp = await fetch(`${TILES_API}/createSession?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "streetview", language: "en-US", region: "US" }),
  });
  if (!resp.ok) throw new Error(`Session creation failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.session;
}

async function fetchPanoIds(locations, session) {
  const resp = await fetch(`${TILES_API}/streetview/panoIds?session=${session}&key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: locations.map((l) => ({ lat: l.lat, lng: l.lon })),
      radius: 50,
    }),
  });
  if (!resp.ok) throw new Error(`panoIds failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.panoIds || [];
}

async function fetchMetadata(panoId, session) {
  const resp = await fetch(
    `${TILES_API}/streetview/metadata?session=${session}&key=${API_KEY}&panoId=${panoId}`
  );
  if (!resp.ok) throw new Error(`Metadata failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// --- Street sampling (port of js/streets.js logic) ---

async function fetchStreets(south, west, north, east) {
  const resp = await fetch(
    `${BACKEND_URL}/streets?south=${south}&west=${west}&north=${north}&east=${east}`
  );
  if (!resp.ok) throw new Error(`Streets API error: ${resp.status}`);
  return resp.json();
}

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sampleStreetPoints(way, intervalMeters) {
  const points = [];
  const nodes = way.geometry;
  for (let i = 0; i < nodes.length - 1; i++) {
    const s = nodes[i], e = nodes[i + 1];
    const dist = haversineMeters(s.lat, s.lon, e.lat, e.lon);
    const samples = Math.max(1, Math.floor(dist / intervalMeters));
    const b = bearing(s.lat, s.lon, e.lat, e.lon);
    for (let j = 0; j < samples; j++) {
      const t = (j + 0.5) / samples;
      points.push({
        lat: s.lat + (e.lat - s.lat) * t,
        lon: s.lon + (e.lon - s.lon) * t,
        bearing: b,
        oneway: way.tags?.oneway || null,
        streetName: way.tags?.name || "Unknown street",
      });
    }
  }
  return points;
}

// --- Detection ---

async function detectSinglePano(panoId, heading, pitch, fov, conf) {
  const resp = await fetch(`${BACKEND_URL}/detect-single-pano`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pano_id: panoId,
      heading,
      pitch,
      fov,
      confidence: conf,
      api_key: API_KEY,
      img_width: DETECTION_IMG_SIZE,
      img_height: DETECTION_IMG_SIZE,
      skip_depth: true,
    }),
  });
  if (!resp.ok) throw new Error(`Detection failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  log(`Walking panoramas in [${south},${west}] - [${north},${east}]`);
  log(`Output: ${outputFile}, interval: ${interval}m, confidence: ${confidence}`);
  if (minTiltOffset > 0) {
    log(`Filtering: only panos with |tilt - 90| >= ${minTiltOffset}°`);
  }

  // Check backend health
  try {
    const health = await fetch(`${BACKEND_URL}/health`);
    if (!health.ok) throw new Error("unhealthy");
    log("Backend is healthy");
  } catch (e) {
    console.error(`Error: Backend not reachable at ${BACKEND_URL}. Start it with: bun run start:backend`);
    process.exit(1);
  }

  // Create session
  log("Creating Map Tiles session...");
  const session = await createSession();

  // Fetch streets
  log("Fetching streets from backend...");
  const ways = await fetchStreets(south, west, north, east);
  log(`Found ${ways.length} streets`);

  // Sample points
  let allPoints = [];
  for (const way of ways) {
    allPoints.push(...sampleStreetPoints(way, interval));
  }
  log(`Sampled ${allPoints.length} points`);

  // Fetch pano IDs in batches
  log("Fetching panorama IDs...");
  const panoMap = new Map(); // panoId -> { lat, lon, bearing, oneway, streetName }
  for (let i = 0; i < allPoints.length; i += PANO_BATCH_SIZE) {
    const batch = allPoints.slice(i, i + PANO_BATCH_SIZE);
    const panoIds = await fetchPanoIds(batch, session);
    for (let j = 0; j < batch.length; j++) {
      const id = typeof panoIds[j] === "string" ? panoIds[j] : panoIds[j]?.panoId;
      if (id) {
        if (!panoMap.has(id)) {
          panoMap.set(id, batch[j]);
        }
      }
    }
    if (i + PANO_BATCH_SIZE < allPoints.length) {
      log(`  ... ${Math.min(i + PANO_BATCH_SIZE, allPoints.length)}/${allPoints.length} locations`);
    }
  }
  log(`Found ${panoMap.size} unique panoramas`);

  // Initialize output file
  writeFileSync(outputFile, "");

  // Walk each panorama: fetch metadata first, filter by tilt, then detect
  let totalDetections = 0;
  let panoIndex = 0;
  let skippedTilt = 0;
  const totalPanos = panoMap.size;

  for (const [panoId, point] of panoMap) {
    panoIndex++;

    // Fetch metadata FIRST for tilt filtering
    let metadata;
    try {
      metadata = await fetchMetadata(panoId, session);
    } catch (e) {
      log(`  Warning: metadata fetch failed for ${panoId}: ${e.message}`);
      continue;
    }

    const tilt = metadata.tilt ?? 90;
    const panoHeading = metadata.heading ?? 0;
    const tiltOffset = Math.abs(tilt - 90);

    // Filter by tilt offset
    if (minTiltOffset > 0 && tiltOffset < minTiltOffset) {
      skippedTilt++;
      continue;
    }

    const sides = [
      { side: "right", heading: (point.bearing + SIDE_OFFSET) % 360 },
      { side: "left", heading: (point.bearing - SIDE_OFFSET + 360) % 360 },
    ];

    // Handle oneway=-1: reverse bearing
    let adjustedBearing = point.bearing;
    if (point.oneway === "-1") {
      adjustedBearing = (point.bearing + 180) % 360;
      sides[0].heading = (adjustedBearing + SIDE_OFFSET) % 360;
      sides[1].heading = (adjustedBearing - SIDE_OFFSET + 360) % 360;
    }

    for (const { side, heading } of sides) {
      try {
        const result = await detectSinglePano(panoId, heading, DETECTION_PITCH, DETECTION_FOV, confidence);

        if (result.detections && result.detections.length > 0) {
          for (const det of result.detections) {
            // Compute predicted equirect position
            const corrected = headingPitchToPixelCorrected(
              det.heading, det.pitch,
              TILE_GRID_WIDTH, TILE_GRID_HEIGHT,
              panoHeading, tilt,
            );

            const record = {
              panoId,
              heading: det.heading,
              pitch: det.pitch,
              angularWidth: det.angular_width,
              angularHeight: det.angular_height,
              confidence: det.confidence,
              detectionFov: DETECTION_FOV,
              detectionPitch: DETECTION_PITCH,
              detectionHeading: heading,
              panoHeading,
              tilt,
              tiltOffset: parseFloat(tiltOffset.toFixed(3)),
              streetBearing: point.bearing,
              side,
              lat: point.lat,
              lon: point.lon,
              imgWidth: DETECTION_IMG_SIZE,
              imgHeight: DETECTION_IMG_SIZE,
              // Gnomonic bbox coords (raw YOLO in 640x640)
              bboxX1: det.bbox_x1 ?? null,
              bboxY1: det.bbox_y1 ?? null,
              bboxX2: det.bbox_x2 ?? null,
              bboxY2: det.bbox_y2 ?? null,
              // Predicted equirect position
              predictedEqX: parseFloat(corrected.x.toFixed(1)),
              predictedEqY: parseFloat(corrected.y.toFixed(1)),
              yCorrection: parseFloat(corrected.yCorrection.toFixed(1)),
            };
            appendFileSync(outputFile, JSON.stringify(record) + "\n");
            totalDetections++;
          }
        }
      } catch (e) {
        log(`  Error detecting ${panoId} (${side}): ${e.message}`);
      }

      await sleep(DETECTION_DELAY_MS);
    }

    if (panoIndex % 10 === 0 || panoIndex === totalPanos) {
      log(`Progress: ${panoIndex}/${totalPanos} panos, ${totalDetections} detections, ${skippedTilt} skipped (tilt)`);
    }
  }

  log(`Done! ${totalDetections} detections written to ${outputFile}`);
  if (skippedTilt > 0) {
    log(`Skipped ${skippedTilt} panos with |tilt - 90| < ${minTiltOffset}°`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
