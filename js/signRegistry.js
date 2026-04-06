// SignRegistry handles deduplication of detected parking signs across panoramas.
// It uses a combination of spatial proximity and fuzzy OCR rule matching.

class SignRegistry {
  constructor() {
    this.signs = []; // Array of canonical unique signs
    this.MATCH_RADIUS_METERS = 15;
    this.SIMILARITY_THRESHOLD = 0.8; // 80% compatibility required
  }

  /**
   * Register a newly detected sign.
   * Returns either an existing UUID (if it's a match) or a new UUID.
   */
  registerSign(detection, ocrResult, cameraLat, cameraLng) {
    if (!ocrResult || !ocrResult.is_parking_sign || !ocrResult.rules) {
      // If it's not a valid parsed sign, just give it a random UUID and don't track it globally
      return crypto.randomUUID();
    }

    // 1. Calculate real-world coordinates for the sign
    const signLoc = projectLatLng(
      cameraLat,
      cameraLng,
      detection.depthCalibrated || 5, // Fallback to 5m if depth unknown
      detection.heading
    );

    // 2. Find candidates within MATCH_RADIUS_METERS
    let bestMatch = null;
    let bestScore = -1;

    for (const existingSign of this.signs) {
      const dist = calculateDistanceMeters(
        signLoc.lat,
        signLoc.lng,
        existingSign.lat,
        existingSign.lng
      );

      if (dist <= this.MATCH_RADIUS_METERS) {
        const score = this.calculateSignSimilarity(existingSign.ocrResult, ocrResult);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = existingSign;
        }
      }
    }

    // 3. If a good match is found, return its UUID
    if (bestMatch && bestScore >= this.SIMILARITY_THRESHOLD) {
      return bestMatch.uuid;
    }

    // 4. Otherwise, register as a new unique sign
    const newUuid = crypto.randomUUID();
    this.signs.push({
      uuid: newUuid,
      lat: signLoc.lat,
      lng: signLoc.lng,
      ocrResult: ocrResult,
      firstDetection: detection, // keep a reference to the first time we saw it
      detections: 1
    });
    
    return newUuid;
  }

  /**
   * Calculates a compatibility score between two OCR results [0.0 - 1.0].
   */
  calculateSignSimilarity(ocr1, ocr2) {
    const rules1 = ocr1.rules || [];
    const rules2 = ocr2.rules || [];

    // Instant disqualification: do they have fundamentally different core categories?
    // E.g. one has 'no_parking' and the other only has 'parking_allowed'
    const cats1 = new Set(rules1.map(r => r.category));
    const cats2 = new Set(rules2.map(r => r.category));
    
    // Check if there is ANY overlap in categories. If not, they are different signs.
    // E.g., comparing a purely "No Parking" sign to a purely "Pay to Park" sign.
    const intersection = [...cats1].filter(x => cats2.has(x));
    if (cats1.size > 0 && cats2.size > 0 && intersection.length === 0) {
      return 0.0;
    }

    // Compare rules. Since OCR might miss a rule, we don't require 100% 1-to-1 match.
    // We calculate a score for the best matching pairs.
    let totalScore = 0;
    let matchedRulesCount = 0;

    // Create a copy of rules2 to keep track of matched ones
    const availableRules2 = [...rules2];

    for (const r1 of rules1) {
      let bestPairScore = -1;
      let bestPairIdx = -1;

      for (let j = 0; j < availableRules2.length; j++) {
        const r2 = availableRules2[j];
        if (r1.category !== r2.category) continue; // Must match category

        const pairScore = this.compareSingleRule(r1, r2);
        if (pairScore > bestPairScore) {
          bestPairScore = pairScore;
          bestPairIdx = j;
        }
      }

      if (bestPairIdx !== -1) {
        totalScore += bestPairScore;
        matchedRulesCount++;
        availableRules2.splice(bestPairIdx, 1); // Remove matched rule
      }
    }

    // Penalty for mismatched total number of rules
    const maxRules = Math.max(rules1.length, rules2.length);
    if (maxRules === 0) return 1.0; // Both empty?

    // Average score across the maximum number of rules the signs have
    // E.g. Sign A has 3 rules, Sign B has 2. They match perfectly on 2. 
    // totalScore = 2.0. Result = 2.0 / 3 = 0.66
    return totalScore / maxRules;
  }

  /**
   * Compare two specific rules of the SAME category.
   * Returns 0.0 to 1.0 based on how well they match.
   */
  compareSingleRule(r1, r2) {
    let score = 0;
    let totalWeight = 0;

    // 1. Time Start/End (Weight: 0.4)
    // Flexible match: ±1 hour or common OCR mistakes (e.g. 6 vs 8)
    const timeScore = this.compareTimes(r1.time_start, r1.time_end, r2.time_start, r2.time_end);
    score += timeScore * 0.4;
    totalWeight += 0.4;

    // 2. Days (Weight: 0.3)
    const daysScore = this.compareDays(r1.days, r2.days);
    score += daysScore * 0.3;
    totalWeight += 0.3;

    // 3. Time Limit (Weight: 0.2)
    const limitScore = this.compareLimits(r1.time_limit_minutes, r2.time_limit_minutes);
    score += limitScore * 0.2;
    totalWeight += 0.2;

    // 4. Arrow Direction (Weight: 0.1)
    if (r1.arrow_direction === r2.arrow_direction) {
      score += 0.1;
    } else if (!r1.arrow_direction || !r2.arrow_direction || r1.arrow_direction === 'none' || r2.arrow_direction === 'none') {
      // One missed the arrow, partial penalty
      score += 0.05;
    }
    totalWeight += 0.1;

    return score / totalWeight;
  }

  compareTimes(start1, end1, start2, end2) {
    if (!start1 && !start2 && !end1 && !end2) return 1.0; // Both missing time constraints = perfect match
    if ((!start1 && start2) || (start1 && !start2)) return 0.5; // One has it, one doesn't = partial

    let matchCount = 0;
    
    if (this.isTimeSimilar(start1, start2)) matchCount++;
    if (this.isTimeSimilar(end1, end2)) matchCount++;

    return matchCount / 2.0;
  }

  isTimeSimilar(t1, t2) {
    if (t1 === t2) return true;
    if (!t1 || !t2) return false;

    // Common OCR digit confusions
    if (t1.replace(/6/g, '8') === t2.replace(/6/g, '8')) return true;

    // Parse HH:MM to minutes
    const parseMins = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + (m || 0);
    };

    try {
      const m1 = parseMins(t1);
      const m2 = parseMins(t2);
      // ±60 mins flexibility
      return Math.abs(m1 - m2) <= 60;
    } catch (e) {
      return false;
    }
  }

  compareDays(days1, days2) {
    if (!days1 && !days2) return 1.0;
    if (!days1 || !days2) return 0.5; // Partial penalty if one OCR missed it

    const s1 = new Set(days1);
    const s2 = new Set(days2);
    
    const intersection = [...s1].filter(x => s2.has(x));
    const union = new Set([...days1, ...days2]);

    // Jaccard similarity for days
    return intersection.length / union.size;
  }

  compareLimits(limit1, limit2) {
    if (limit1 === limit2) return 1.0;
    if (!limit1 || !limit2) return 0.5; // Missing from one
    // E.g. 120 vs 60 -> maybe partial? For now, 0 if different
    return 0.0; 
  }
}

// Haversine formula for distance between lat/lng
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180; // φ, λ in radians
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // in metres
}

// Export for module systems or attach to window
if (typeof window !== 'undefined') {
  window.SignRegistry = SignRegistry;
}
