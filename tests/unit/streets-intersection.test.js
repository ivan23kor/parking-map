/**
 * Unit tests for street intersection detection.
 * Tests findIntersectionNodes() with various intersection configurations.
 */

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

// Test cases
const tests = [
    {
        name: "T-intersection: way 1 (N-S) crosses way 2 (E-W), shared node in middle",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Main St" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },  // shared node
                    { lat: 40.1, lon: -72.9 },
                ],
                tags: { name: "Cross St" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
    },

    {
        name: "Cross intersection: 2 ways cross at center node",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "NS St" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },  // shared
                    { lat: 40.1, lon: -72.9 },
                ],
                tags: { name: "EW St" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
    },

    {
        name: "No intersection: parallel ways, no shared nodes",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way A" },
            },
            {
                geometry: [
                    { lat: 40.0, lon: -73.1 },
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.2, lon: -73.1 },
                ],
                tags: { name: "Way B (parallel)" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Endpoint intersection: ways meet at endpoint",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },
            { lat: 40.2, lon: -73.0 },  // endpoint is intersection
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way A" },
            },
            {
                geometry: [
                    { lat: 40.2, lon: -73.1 },
                    { lat: 40.2, lon: -73.0 },  // connects to endpoint
                ],
                tags: { name: "Way B" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [2],
    },

    {
        name: "Multiple intersections along way",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },  // intersection at nodeIndex 0
            { lat: 40.1, lon: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lon: -73.0 },  // intersection at nodeIndex 2
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Main St" },
            },
            {
                geometry: [
                    { lat: 40.0, lon: -73.1 },
                    { lat: 40.0, lon: -73.0 },  // connects at first node
                ],
                tags: { name: "Cross 1" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },  // connects at second node
                ],
                tags: { name: "Cross 2" },
            },
            {
                geometry: [
                    { lat: 40.2, lon: -73.1 },
                    { lat: 40.2, lon: -73.0 },  // connects at third node
                ],
                tags: { name: "Cross 3" },
            },
        ],
        expectedCount: 3,
        expectedNodeIndices: [0, 1, 2],
    },

    {
        name: "Empty wayGeometry returns empty result",
        wayGeometry: [],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                ],
                tags: { name: "Some St" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Empty allWays returns empty result",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },
        ],
        allWays: [],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Null wayGeometry returns empty result",
        wayGeometry: null,
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                ],
                tags: { name: "Some St" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Way with lng property instead of lon",
        wayGeometry: [
            { lat: 40.0, lng: -73.0 },
            { lat: 40.1, lng: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lng: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lng: -73.0 },
                    { lat: 40.1, lng: -73.0 },
                    { lat: 40.2, lng: -73.0 },
                ],
                tags: { name: "Main St" },
            },
            {
                geometry: [
                    { lat: 40.1, lng: -73.1 },
                    { lat: 40.1, lng: -73.0 },  // shared node
                    { lat: 40.1, lng: -72.9 },
                ],
                tags: { name: "Cross St" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
    },

    {
        name: "Skip invalid lat/lon values",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: null, lon: -73.0 },    // invalid
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: null, lon: -73.0 },  // invalid in other way too, but shouldn't match
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way A" },
            },
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way B" },
            },
        ],
        expectedCount: 2,  // nodes at indices 0 and 2 appear in 2 ways
        expectedNodeIndices: [0, 2],
    },
];

// Run tests
console.log("Running findIntersectionNodes() unit tests...\n");
let passed = 0;
let failed = 0;

for (const test of tests) {
    const result = findIntersectionNodes(test.wayGeometry, test.allWays);

    const countMatch = result.length === test.expectedCount;
    const indicesMatch =
        result.length === test.expectedNodeIndices.length &&
        result.every((node, i) => node.nodeIndex === test.expectedNodeIndices[i]);
    const success = countMatch && indicesMatch;

    if (success) {
        console.log(`✓ ${test.name}`);
        passed++;
    } else {
        console.log(`✗ ${test.name}`);
        if (!countMatch) {
            console.log(`  Expected ${test.expectedCount} intersections, got ${result.length}`);
        }
        if (!indicesMatch) {
            const actualIndices = result.map(n => n.nodeIndex);
            console.log(`  Expected nodeIndices ${test.expectedNodeIndices}, got ${actualIndices}`);
        }
        if (result.length > 0) {
            console.log(`  Full result:`, JSON.stringify(result, null, 2));
        }
        failed++;
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
