/**
 * Parking sign detection module.
 * Handles API calls and bounding box overlay on interactive panorama.
 */

// Detection state
let detectionPanorama = null;
let currentDetections = [];  // Store detections as {heading, pitch, angularWidth, angularHeight, confidence, class_name}
let detectionPov = { heading: 0, pitch: 0, zoom: 1 };  // POV when detection was run
let povChangeListener = null;
let panoChangeListener = null;

/**
 * Calculate FOV from Street View zoom level.
 * Google's Street View uses: fov = 2 * atan(2^(1-zoom))
 * @param {number} zoom - Zoom level (typically 0-4)
 * @returns {number} Field of view in degrees
 */
function zoomToFov(zoom) {
    return Math.atan(Math.pow(2, 1 - zoom)) * 360 / Math.PI;
}

// Tile constants
const TILE_SIZE = 512;  // Street View tile size in pixels
const MAX_ZOOM = 5;     // Maximum zoom level for Street View tiles
const TILE_GRID_WIDTH = 32 * TILE_SIZE;   // 16384
const TILE_GRID_HEIGHT = 16 * TILE_SIZE;  // 8192

/**
 * Convert heading/pitch to pixel coordinates in the full panorama.
 * Uses equirectangular projection.
 */
function headingPitchToPixel(heading, pitch, imageWidth, imageHeight, panoHeading = 0) {
    // Convert compass heading to panorama-relative heading
    // Add 180° because x=0 is the BACK of the panorama, not the front
    let h = (heading - panoHeading + 180 + 360) % 360;
    
    // Equirectangular projection
    const x = (h / 360) * imageWidth;
    const y = ((90 - pitch) / 180) * imageHeight;
    
    return { x, y };
}

/**
 * Convert angular dimensions to pixel dimensions.
 */
function angularToPixelSize(angularWidth, angularHeight, imageWidth, imageHeight) {
    const width = (angularWidth / 360) * imageWidth;
    const height = (angularHeight / 180) * imageHeight;
    return { width, height };
}

/**
 * Get tile coordinates that cover a pixel region.
 */
function getTilesForRegion(x, y, width, height, padding = 1.2) {
    const pw = width * padding;
    const ph = height * padding;
    
    // Calculate bounds - center the crop on (x, y)
    // Shift DOWN by ph/2 to fix vertical alignment
    const yOffset = ph / 2;
    const x1 = x - pw / 2;
    const y1 = y - ph / 2 + yOffset;
    const x2 = x + pw / 2;
    const y2 = y + ph / 2 + yOffset;
    
    // Calculate tile coordinates
    const tileX1 = Math.floor(x1 / TILE_SIZE);
    const tileY1 = Math.floor(y1 / TILE_SIZE);
    const tileX2 = Math.floor(x2 / TILE_SIZE);
    const tileY2 = Math.floor(y2 / TILE_SIZE);
    
    // Collect all tiles needed
    const tiles = [];
    for (let ty = tileY1; ty <= tileY2; ty++) {
        for (let tx = tileX1; tx <= tileX2; tx++) {
            tiles.push({ x: tx, y: ty });
        }
    }
    
    // Calculate crop bounds within the stitched tile image
    const stitchOriginX = tileX1 * TILE_SIZE;
    const stitchOriginY = tileY1 * TILE_SIZE;
    
    const cropBounds = {
        x: Math.round(x1 - stitchOriginX),
        y: Math.round(y1 - stitchOriginY),
        width: Math.round(pw),
        height: Math.round(ph)
    };
    
    return { tiles, tileX1, tileY1, cropBounds };
}

/**
 * Build Street View Static API URL.
 */
function getStreetViewImageUrl(panoId, heading, pitch = 0, fov = 90, width = 640, height = 640) {
    const apiKey = window.GOOGLE_CONFIG?.API_KEY;
    if (!apiKey) {
        throw new Error('Google API key not configured');
    }
    
    return `https://maps.googleapis.com/maps/api/streetview?` +
        `size=${width}x${height}` +
        `&pano=${panoId}` +
        `&heading=${heading}` +
        `&pitch=${pitch}` +
        `&fov=${fov}` +
        `&key=${apiKey}`;
}

/**
 * Run detection on a Street View image.
 */
async function runDetection(imageUrl, confidence = null) {
    const apiUrl = window.DETECTION_CONFIG?.API_URL;
    if (!apiUrl) {
        throw new Error('Detection API URL not configured');
    }

    const conf = confidence ?? window.DETECTION_CONFIG?.CONFIDENCE_THRESHOLD ?? 0.15;

    let resp;
    try {
        resp = await fetch(`${apiUrl}/detect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image_url: imageUrl,
                confidence: conf
            })
        });
    } catch (err) {
        console.error('Detection request failed:', err);
        throw new Error(`Can't reach detection API. Make sure backend is running.`);
    }

    if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Detection failed: ${resp.status} - ${errorText}`);
    }

    return resp.json();
}

/**
 * Convert pixel coordinates to angular coordinates relative to POV.
 */
function pixelToAngular(x, y, hFov, imgWidth, imgHeight) {
    const centerX = imgWidth / 2;
    const centerY = imgHeight / 2;
    const vFov = hFov * (imgHeight / imgWidth);
    
    const degreesPerPixelX = hFov / imgWidth;
    const degreesPerPixelY = vFov / imgHeight;
    
    const headingOffset = (x - centerX) * degreesPerPixelX;
    const pitchOffset = -(y - centerY) * degreesPerPixelY;
    
    return { headingOffset, pitchOffset };
}

/**
 * Convert detection box to angular coordinates.
 */
function detectionToAngular(det, povHeading, povPitch, hFov, imgWidth, imgHeight) {
    const centerX = (det.x1 + det.x2) / 2;
    const centerY = (det.y1 + det.y2) / 2;
    const width = det.x2 - det.x1;
    const height = det.y2 - det.y1;
    
    const { headingOffset, pitchOffset } = pixelToAngular(centerX, centerY, hFov, imgWidth, imgHeight);
    
    const vFov = hFov * (imgHeight / imgWidth);
    const degreesPerPixelX = hFov / imgWidth;
    const degreesPerPixelY = vFov / imgHeight;
    
    return {
        heading: povHeading + headingOffset,
        pitch: povPitch + pitchOffset,
        angularWidth: width * degreesPerPixelX,
        angularHeight: height * degreesPerPixelY,
        confidence: det.confidence,
        class_name: det.class_name
    };
}

/**
 * Convert angular detection back to screen coordinates using gnomonic projection.
 */
function angularToScreen(angularDet, currentHeading, currentPitch, currentFov, screenWidth, screenHeight) {
    const toRad = deg => deg * Math.PI / 180;
    
    let headingDiff = angularDet.heading - currentHeading;
    if (headingDiff > 180) headingDiff -= 360;
    if (headingDiff < -180) headingDiff += 360;
    
    const pitchDiff = angularDet.pitch - currentPitch;
    
    const halfHFov = currentFov / 2;
    if (Math.abs(headingDiff) > Math.min(85, halfHFov + 20)) return null;
    if (Math.abs(pitchDiff) > 60) return null;
    
    const focalLength = (screenWidth / 2) / Math.tan(toRad(currentFov / 2));
    
    const centerX = screenWidth / 2 + focalLength * Math.tan(toRad(headingDiff));
    const centerY = screenHeight / 2 - focalLength * Math.tan(toRad(pitchDiff));
    
    const halfAngW = angularDet.angularWidth / 2;
    const halfAngH = angularDet.angularHeight / 2;
    
    const leftX = screenWidth / 2 + focalLength * Math.tan(toRad(headingDiff - halfAngW));
    const rightX = screenWidth / 2 + focalLength * Math.tan(toRad(headingDiff + halfAngW));
    const topY = screenHeight / 2 - focalLength * Math.tan(toRad(pitchDiff + halfAngH));
    const bottomY = screenHeight / 2 - focalLength * Math.tan(toRad(pitchDiff - halfAngH));
    
    const width = rightX - leftX;
    const height = bottomY - topY;
    
    if (centerX + width / 2 < 0 || centerX - width / 2 > screenWidth) return null;
    if (centerY + height / 2 < 0 || centerY - height / 2 > screenHeight) return null;
    
    return {
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
        confidence: angularDet.confidence,
        class_name: angularDet.class_name
    };
}

/**
 * Update SVG overlay with detection boxes.
 */
function updateDetectionOverlay() {
    const overlay = document.getElementById('detectionOverlay');
    if (!overlay || !detectionPanorama) return;
    
    const pov = detectionPanorama.getPov();
    const container = document.getElementById('detectionPanorama');
    const width = container.clientWidth;
    const height = container.clientHeight;
    const fov = zoomToFov(pov.zoom || 1);
    
    // Clear existing boxes
    overlay.innerHTML = '';
    
    // Draw each detection if visible
    for (const det of currentDetections) {
        const screen = angularToScreen(det, pov.heading, pov.pitch, fov, width, height);
        if (!screen) continue;
        
        // Color based on confidence
        const hue = det.confidence * 120;
        const color = `hsl(${hue}, 100%, 50%)`;
        
        // Create clickable rect
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', screen.x);
        rect.setAttribute('y', screen.y);
        rect.setAttribute('width', screen.width);
        rect.setAttribute('height', screen.height);
        rect.setAttribute('fill', 'rgba(255, 255, 255, 0.1)');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '3');
        rect.style.cursor = 'pointer';
        rect.style.transition = 'all 0.15s ease';
        rect.style.pointerEvents = 'auto';
        
        // Hover effects
        rect.addEventListener('mouseenter', () => {
            rect.setAttribute('stroke-width', '5');
            rect.setAttribute('fill', 'rgba(255, 255, 255, 0.3)');
            rect.style.filter = 'drop-shadow(0 0 8px rgba(255, 255, 255, 0.8))';
        });
        rect.addEventListener('mouseleave', () => {
            rect.setAttribute('stroke-width', '3');
            rect.setAttribute('fill', 'rgba(255, 255, 255, 0.1)');
            rect.style.filter = 'none';
        });
        
        // Click to save sign
        rect.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            cropAndSaveSign(det);
        });
        rect.addEventListener('mousedown', (e) => e.stopPropagation());
        rect.addEventListener('mouseup', (e) => e.stopPropagation());
        overlay.appendChild(rect);
        
        // Create label
        const label = `${det.class_name} ${Math.round(det.confidence * 100)}%`;
        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelBg.setAttribute('x', screen.x);
        labelBg.setAttribute('y', screen.y - 20);
        labelBg.setAttribute('width', label.length * 8 + 8);
        labelBg.setAttribute('height', '18');
        labelBg.setAttribute('fill', color);
        overlay.appendChild(labelBg);
        
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', screen.x + 4);
        text.setAttribute('y', screen.y - 6);
        text.setAttribute('fill', 'white');
        text.setAttribute('font-size', '12');
        text.setAttribute('font-weight', 'bold');
        text.textContent = label;
        overlay.appendChild(text);
    }
}

/**
 * Initialize or update the detection panorama.
 */
function initDetectionPanorama(panoId, heading, container) {
    const pov = getDefaultPov(heading);
    
    if (detectionPanorama) {
        detectionPanorama.setPano(panoId);
        detectionPanorama.setPov(pov);
    } else {
        detectionPanorama = new google.maps.StreetViewPanorama(container, {
            pano: panoId,
            pov,
            zoom: PANORAMA_DEFAULTS.zoom,
            addressControl: false,
            showRoadLabels: false,
            motionTracking: false,
            motionTrackingControl: false,
            linksControl: false,
            panControl: true,
            zoomControl: true,
            fullscreenControl: false
        });
        
        povChangeListener = detectionPanorama.addListener('pov_changed', updateDetectionOverlay);
        panoChangeListener = detectionPanorama.addListener('pano_changed', clearDetections);
    }
    
    currentDetections = [];
    updateDetectionOverlay();
}

/**
 * Clear current detections.
 */
function clearDetections() {
    currentDetections = [];
    updateDetectionOverlay();
    
    const statusEl = document.getElementById('detectionStatus');
    if (statusEl) {
        statusEl.textContent = 'Panorama changed. Click "Detect" to scan for parking signs';
    }
}

/**
 * Run detection and display results on panorama.
 */
async function runDetectionOnPanorama(panoId, heading, statusEl, useCurrentPov = false) {
    let fov = 90;
    let pitch = PANORAMA_DEFAULTS.pitch;
    let detectHeading = heading;
    let detectPanoId = panoId;
    
    const container = document.getElementById('detectionPanorama');
    const screenWidth = container?.clientWidth || 1920;
    const screenHeight = container?.clientHeight || 1080;
    const aspectRatio = screenWidth / screenHeight;
    
    let imgWidth, imgHeight;
    if (aspectRatio >= 1) {
        imgWidth = 640;
        imgHeight = Math.round(640 / aspectRatio);
    } else {
        imgHeight = 640;
        imgWidth = Math.round(640 * aspectRatio);
    }
    
    if (useCurrentPov && detectionPanorama) {
        const pov = detectionPanorama.getPov();
        detectHeading = pov.heading;
        pitch = pov.pitch;
        fov = zoomToFov(pov.zoom || 1);
        fov = Math.min(120, Math.max(20, fov));

        if (typeof detectionPanorama.getPano === 'function') {
            const currentPano = detectionPanorama.getPano();
            if (currentPano) detectPanoId = currentPano;
        }
    }
    
    const imageUrl = getStreetViewImageUrl(detectPanoId, detectHeading, pitch, fov, imgWidth, imgHeight);
    
    if (statusEl) statusEl.textContent = 'Detecting parking signs...';
    
    try {
        const result = await runDetection(imageUrl);
        
        currentDetections = result.detections.map(det => 
            detectionToAngular(det, detectHeading, pitch, fov, imgWidth, imgHeight)
        );
        
        detectionPov = { heading: detectHeading, pitch, fov };
        updateDetectionOverlay();
        
        const count = result.detections.length;
        const timeMs = result.inference_time_ms;
        if (statusEl) {
            statusEl.textContent = count > 0 
                ? `Found ${count} parking sign${count > 1 ? 's' : ''} (${timeMs}ms). Click a box to save.`
                : `No parking signs detected (${timeMs}ms)`;
        }
        
        return result;
    } catch (err) {
        console.error('Detection error:', err);
        if (statusEl) statusEl.textContent = `Detection failed: ${err.message}`;
        throw err;
    }
}

/**
 * Crop and save sign using high-resolution tiles.
 */
async function cropAndSaveSign(det) {
    const statusEl = document.getElementById('status') || document.getElementById('detectionStatus');
    const apiUrl = window.DETECTION_CONFIG?.API_URL;
    
    if (!apiUrl || !detectionPanorama) {
        if (statusEl) statusEl.textContent = 'Cannot save: API not configured';
        return;
    }
    
    const panoId = detectionPanorama.getPano();
    if (!panoId) {
        if (statusEl) statusEl.textContent = 'Cannot save: no panorama loaded';
        return;
    }
    
    if (statusEl) statusEl.textContent = 'Saving sign...';
    
    try {
        const session = await getSessionToken();
        const metadata = await fetchStreetViewMetadata(panoId, session);
        
        const imageWidth = TILE_GRID_WIDTH;
        const imageHeight = TILE_GRID_HEIGHT;
        const panoHeading = metadata.heading || 0;
        
        const signCenter = headingPitchToPixel(det.heading, det.pitch, imageWidth, imageHeight, panoHeading);
        const signSize = angularToPixelSize(det.angularWidth, det.angularHeight, imageWidth, imageHeight);
        
        const { tiles, tileX1, tileY1, cropBounds } = getTilesForRegion(
            signCenter.x, signCenter.y, signSize.width, signSize.height
        );
        
        const resp = await fetch(`${apiUrl}/crop-sign-tiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pano_id: panoId,
                tiles: tiles,
                tile_x1: tileX1,
                tile_y1: tileY1,
                crop_x: cropBounds.x,
                crop_y: cropBounds.y,
                crop_width: cropBounds.width,
                crop_height: cropBounds.height,
                confidence: det.confidence,
                api_key: window.GOOGLE_CONFIG?.API_KEY,
                session_token: session
            })
        });
        
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Save failed: ${resp.status} - ${errText}`);
        }
        
        const result = await resp.json();
        
        if (statusEl) {
            statusEl.textContent = `Saved: ${result.filename} (${result.width}x${result.height}px)`;
        }
        
    } catch (err) {
        console.error('Save error:', err);
        if (statusEl) statusEl.textContent = `Save failed: ${err.message}`;
    }
}

/**
 * Clean up detection panorama when closing modal.
 */
function cleanupDetectionPanorama() {
    currentDetections = [];
    if (document.getElementById('detectionOverlay')) {
        document.getElementById('detectionOverlay').innerHTML = '';
    }
}
