/**
 * Street data fetching and sampling utilities.
 * Uses Overpass API for OSM data and Turf.js for geometry calculations.
 */

/**
 * Fetch streets from Overpass API within given bounds.
 * @param {L.LatLngBounds} bounds - Leaflet bounds object
 * @returns {Promise<Array>} Array of way objects with geometry and tags
 */
async function fetchStreets(bounds) {
    const overpassQuery = `
        [out:json][timeout:30];
        (
            way["highway"~"^(primary|secondary|tertiary|residential|unclassified)$"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});
        );
        (._;>;);
        out geom;
    `;

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                body: overpassQuery
            });

            if (!response.ok) {
                if (response.status === 504 && attempt < 2) {
                    const delay = Math.pow(2, attempt) * 1000;
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw new Error(`Overpass API error: ${response.status}`);
            }

            const data = await response.json();

            // Extract ways with geometry
            const ways = [];
            if (data.elements) {
                for (const element of data.elements) {
                    if (element.type === 'way' && element.geometry && element.geometry.length >= 2) {
                        ways.push({
                            id: element.id,
                            geometry: element.geometry,
                            tags: element.tags || {}
                        });
                    }
                }
            }

            return ways;

        } catch (err) {
            lastError = err;
            if (attempt < 2) continue;
        }
    }

    throw lastError;
}

/**
 * Sample points along a street at regular intervals.
 * Uses Turf.js bearing() for correct spherical geometry.
 * @param {Object} way - Way object with geometry and tags
 * @param {number} intervalMeters - Sampling interval in meters (default 50)
 * @returns {Array} Array of point objects with lat, lon, bearing, oneway
 */
function sampleStreetPoints(way, intervalMeters = 50) {
    const points = [];
    const nodes = way.geometry;

    for (let i = 0; i < nodes.length - 1; i++) {
        const startNode = nodes[i];
        const endNode = nodes[i + 1];

        const start = turf.point([startNode.lon, startNode.lat]);
        const end = turf.point([endNode.lon, endNode.lat]);

        // Distance in meters
        const segmentDist = turf.distance(start, end, { units: 'meters' });

        // Number of samples on this segment
        const samples = Math.max(1, Math.floor(segmentDist / intervalMeters));

        // Bearing from start to end (correct spherical calculation)
        const bearing = turf.bearing(start, end);

        for (let j = 0; j < samples; j++) {
            // Place point at center of each interval
            const t = (j + 0.5) / samples;
            const lat = startNode.lat + (endNode.lat - startNode.lat) * t;
            const lon = startNode.lon + (endNode.lon - startNode.lon) * t;

            points.push({
                lat,
                lon,
                bearing,
                oneway: way.tags.oneway || null,
                highway: way.tags.highway || null,
                lanes: way.tags.lanes || null,
                streetName: way.tags.name || 'Unknown street',
                segmentStart: {
                    lat: startNode.lat,
                    lon: startNode.lon
                },
                segmentEnd: {
                    lat: endNode.lat,
                    lon: endNode.lon
                },
                wayGeometry: nodes.map(n => ({ lat: n.lat, lon: n.lon })),
                segmentIndex: i
            });
        }
    }

    return points;
}

/**
 * Convert Overpass data to GeoJSON for map display.
 * @param {Array} ways - Array of way objects
 * @returns {Object} GeoJSON FeatureCollection
 */
function waysToGeoJSON(ways) {
    const features = ways.map(way => ({
        type: 'Feature',
        properties: {
            id: way.id,
            name: way.tags.name || 'Unnamed street',
            highway: way.tags.highway || 'road',
            oneway: way.tags.oneway || null
        },
        geometry: {
            type: 'LineString',
            coordinates: way.geometry.map(node => [node.lon, node.lat])
        }
    }));

    return {
        type: 'FeatureCollection',
        features
    };
}

/**
 * Clip streets to selection bounds.
 * @param {Array} ways - Array of way objects
 * @param {L.LatLngBounds} bounds - Leaflet bounds to clip to
 * @returns {Array} Clipped way objects
 */
function clipStreetsToBounds(ways, bounds) {
    const bbox = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth()
    ];

    const clippedWays = [];

    for (const way of ways) {
        const line = turf.lineString(
            way.geometry.map(node => [node.lon, node.lat])
        );

        try {
            const clipped = turf.bboxClip(line, bbox);

            // bboxClip can return MultiLineString if line crosses bbox multiple times
            if (clipped.geometry.type === 'LineString' && clipped.geometry.coordinates.length >= 2) {
                clippedWays.push({
                    ...way,
                    geometry: clipped.geometry.coordinates.map(coord => ({ lon: coord[0], lat: coord[1] }))
                });
            } else if (clipped.geometry.type === 'MultiLineString') {
                // Handle MultiLineString by creating separate ways
                for (const coords of clipped.geometry.coordinates) {
                    if (coords.length >= 2) {
                        clippedWays.push({
                            ...way,
                            id: `${way.id}_${clippedWays.length}`,
                            geometry: coords.map(coord => ({ lon: coord[0], lat: coord[1] }))
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to clip way:', way.id, e);
        }
    }

    return clippedWays;
}

function createBoundsAroundPoint(lat, lon, radiusMeters = 120) {
    const latDelta = radiusMeters / 111320;
    const lngDelta =
        radiusMeters /
        (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));

    return {
        getSouth: () => lat - latDelta,
        getWest: () => lon - lngDelta,
        getNorth: () => lat + latDelta,
        getEast: () => lon + lngDelta
    };
}

function toLocalMeters(lat, lon, originLat, originLon) {
    const latScale = 111320;
    const lngScale = 111320 * Math.cos((originLat * Math.PI) / 180);

    return {
        x: (lon - originLon) * lngScale,
        y: (lat - originLat) * latScale
    };
}

function distanceToSegmentMeters(point, start, end) {
    const abx = end.x - start.x;
    const aby = end.y - start.y;
    const abLenSq = abx * abx + aby * aby;
    if (abLenSq <= 1e-6) {
        return Math.hypot(point.x - start.x, point.y - start.y);
    }

    const apx = point.x - start.x;
    const apy = point.y - start.y;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
    const closestX = start.x + abx * t;
    const closestY = start.y + aby * t;

    return Math.hypot(point.x - closestX, point.y - closestY);
}

function findNearestStreetContext(lat, lon, ways) {
    const point = { x: 0, y: 0 };
    let nearest = null;

    for (const way of ways) {
        const nodes = way.geometry || [];
        for (let i = 0; i < nodes.length - 1; i++) {
            const segmentStart = nodes[i];
            const segmentEnd = nodes[i + 1];
            const start = toLocalMeters(segmentStart.lat, segmentStart.lon, lat, lon);
            const end = toLocalMeters(segmentEnd.lat, segmentEnd.lon, lat, lon);
            const distanceMeters = distanceToSegmentMeters(point, start, end);

            if (nearest && distanceMeters >= nearest.distanceMeters) {
                continue;
            }

            nearest = {
                distanceMeters,
                bearing: turf.bearing(
                    turf.point([segmentStart.lon, segmentStart.lat]),
                    turf.point([segmentEnd.lon, segmentEnd.lat])
                ),
                oneway: way.tags.oneway || null,
                highway: way.tags.highway || null,
                lanes: way.tags.lanes || null,
                streetName: way.tags.name || 'Unknown street',
                segmentStart: {
                    lat: segmentStart.lat,
                    lon: segmentStart.lon
                },
                segmentEnd: {
                    lat: segmentEnd.lat,
                    lon: segmentEnd.lon
                },
                wayGeometry: nodes.map(n => ({ lat: n.lat, lon: n.lon })),
                segmentIndex: i,
                allWays: ways
            };
        }
    }

    return nearest;
}

/**
 * Find nodes in wayGeometry that are shared with other ways (street intersections).
 * @param {Array} wayGeometry - Nodes of the main way [{lat, lon}, ...]
 * @param {Array} allWays - All ways in the area from Overpass [{geometry, tags}, ...]
 * @returns {Array} Intersection nodes [{lat, lon, nodeIndex}, ...]
 */
function findIntersectionNodes(wayGeometry, allWays) {
    if (!wayGeometry || wayGeometry.length === 0 || !allWays || allWays.length === 0) {
        return [];
    }

    const PRECISION = 5; // ~1m at equator
    const coordKeyToWayCount = new Map();

    // Count how many ways each coordinate appears in
    for (const way of allWays) {
        const nodes = way.geometry || [];
        const seenKeys = new Set(); // Avoid double-counting same node in same way

        for (const node of nodes) {
            const lat = node.lat;
            const lng = node.lon ?? node.lng;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

            const key = `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                coordKeyToWayCount.set(key, (coordKeyToWayCount.get(key) || 0) + 1);
            }
        }
    }

    // Find wayGeometry nodes appearing in 2+ ways (intersections)
    const intersectionNodes = [];
    for (let nodeIdx = 0; nodeIdx < wayGeometry.length; nodeIdx++) {
        const node = wayGeometry[nodeIdx];
        const lat = node.lat;
        const lng = node.lon ?? node.lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const key = `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}`;
        const wayCount = coordKeyToWayCount.get(key) || 0;

        if (wayCount >= 2) {
            intersectionNodes.push({
                lat,
                lng,
                nodeIndex: nodeIdx,
            });
        }
    }

    return intersectionNodes;
}

async function fetchNearestStreetContext(lat, lon, radiusMeters = 120) {
    const ways = await fetchStreets(createBoundsAroundPoint(lat, lon, radiusMeters));
    return findNearestStreetContext(lat, lon, ways);
}
