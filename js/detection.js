/**
 * Parking sign detection module.
 * Handles API calls and bounding box rendering.
 */

/**
 * Build Street View Static API URL.
 * @param {string} panoId - Panorama ID
 * @param {number} heading - View heading in degrees
 * @param {number} width - Image width (max 640)
 * @param {number} height - Image height (max 640)
 * @returns {string} Street View Static API URL
 */
function getStreetViewImageUrl(panoId, heading, width = 640, height = 640) {
    const apiKey = window.GOOGLE_CONFIG?.API_KEY;
    if (!apiKey) {
        throw new Error('Google API key not configured');
    }
    
    return `https://maps.googleapis.com/maps/api/streetview?` +
        `size=${width}x${height}` +
        `&pano=${panoId}` +
        `&heading=${heading}` +
        `&pitch=-5` +
        `&key=${apiKey}`;
}

/**
 * Run detection on a Street View image.
 * @param {string} imageUrl - URL of the image to analyze
 * @param {number} confidence - Confidence threshold (0-1)
 * @returns {Promise<Object>} Detection response with boxes and timing
 */
async function runDetection(imageUrl, confidence = null) {
    const apiUrl = window.DETECTION_CONFIG?.API_URL;
    if (!apiUrl) {
        throw new Error('Detection API URL not configured');
    }
    
    const conf = confidence ?? window.DETECTION_CONFIG?.CONFIDENCE_THRESHOLD ?? 0.15;
    
    const resp = await fetch(`${apiUrl}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image_url: imageUrl,
            confidence: conf
        })
    });
    
    if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Detection failed: ${resp.status} - ${errorText}`);
    }
    
    return resp.json();
}

/**
 * Check if detection backend is available.
 * @returns {Promise<boolean>} True if backend is healthy
 */
async function isDetectionAvailable() {
    const apiUrl = window.DETECTION_CONFIG?.API_URL;
    if (!apiUrl) return false;
    
    try {
        const resp = await fetch(`${apiUrl}/health`, { timeout: 2000 });
        return resp.ok;
    } catch {
        return false;
    }
}

/**
 * Draw detection boxes on a canvas.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Array} detections - Array of detection objects
 * @param {number} scaleX - X scale factor (canvas width / image width)
 * @param {number} scaleY - Y scale factor (canvas height / image height)
 */
function drawDetections(ctx, detections, scaleX = 1, scaleY = 1) {
    ctx.lineWidth = 3;
    ctx.font = 'bold 14px Arial';
    
    for (const det of detections) {
        const x1 = det.x1 * scaleX;
        const y1 = det.y1 * scaleY;
        const x2 = det.x2 * scaleX;
        const y2 = det.y2 * scaleY;
        const width = x2 - x1;
        const height = y2 - y1;
        
        // Color based on confidence
        const hue = det.confidence * 120; // 0 = red, 120 = green
        const color = `hsl(${hue}, 100%, 50%)`;
        
        // Draw box
        ctx.strokeStyle = color;
        ctx.strokeRect(x1, y1, width, height);
        
        // Draw label background
        const label = `${det.class_name} ${(det.confidence * 100).toFixed(0)}%`;
        const labelWidth = ctx.measureText(label).width + 8;
        const labelHeight = 20;
        
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - labelHeight, labelWidth, labelHeight);
        
        // Draw label text
        ctx.fillStyle = 'white';
        ctx.fillText(label, x1 + 4, y1 - 5);
    }
}

/**
 * Load an image and return its dimensions.
 * @param {string} url - Image URL
 * @returns {Promise<{img: HTMLImageElement, width: number, height: number}>}
 */
function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve({ img, width: img.width, height: img.height });
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = url;
    });
}

/**
 * Run full detection pipeline and render to canvas.
 * @param {string} panoId - Panorama ID
 * @param {number} heading - View heading
 * @param {HTMLCanvasElement} canvas - Canvas element to render to
 * @param {HTMLElement} statusEl - Element to show status text
 * @returns {Promise<Object>} Detection results
 */
async function detectAndRender(panoId, heading, canvas, statusEl) {
    const ctx = canvas.getContext('2d');
    
    // Build image URL
    const imageUrl = getStreetViewImageUrl(panoId, heading, 640, 640);
    
    // Update status
    if (statusEl) statusEl.textContent = 'Loading image...';
    
    // Load image
    const { img, width, height } = await loadImage(imageUrl);
    
    // Set canvas size
    canvas.width = width;
    canvas.height = height;
    
    // Draw image
    ctx.drawImage(img, 0, 0);
    
    // Run detection
    if (statusEl) statusEl.textContent = 'Detecting parking signs...';
    
    try {
        const result = await runDetection(imageUrl);
        
        // Draw boxes
        drawDetections(ctx, result.detections);
        
        // Update status
        const count = result.detections.length;
        const timeMs = result.inference_time_ms;
        if (statusEl) {
            statusEl.textContent = count > 0 
                ? `Found ${count} parking sign${count > 1 ? 's' : ''} (${timeMs}ms)`
                : `No parking signs detected (${timeMs}ms)`;
        }
        
        return result;
    } catch (err) {
        console.error('Detection error:', err);
        if (statusEl) statusEl.textContent = `Detection failed: ${err.message}`;
        throw err;
    }
}
