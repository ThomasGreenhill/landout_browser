/**
 * Client-side computer vision for detecting landing fields in satellite imagery.
 * Uses ray-casting to find the longest unobstructed straight run from the waypoint.
 * For known airfields, uses .cup runway metadata directly.
 */

export interface FieldDetection {
  boundaryPixels: Array<{ x: number; y: number }>;
  centerPixel: { x: number; y: number };
  lengthM: number;
  widthM: number;
  orientationDeg: number;
  surface: 'grass' | 'crop' | 'stubble' | 'bare_earth' | 'paved' | 'mixed' | 'unknown';
  obstructions: Array<{
    type: 'trees' | 'building' | 'road' | 'water' | 'other';
    pixelPos: { x: number; y: number };
    direction: string;
  }>;
  fieldPixelCount: number;
  areaSqM: number;
}

export interface RunwayHint {
  rwdir: number;
  rwlen: number;
  rwwidth: number;
}

// --- Color utilities ---

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function samplePatch(data: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, radius: number): [number, number, number] {
  let tr = 0, tg = 0, tb = 0, count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      tr += data[i]; tg += data[i + 1]; tb += data[i + 2];
      count++;
    }
  }
  return count > 0 ? [tr / count, tg / count, tb / count] : [128, 128, 128];
}

// --- Ray measurement ---

/**
 * Scan a perpendicular cross-section at a point along a direction
 * and find the strip width by detecting color edges on both sides.
 * Returns the left and right edge distances from center, or null if
 * no clear strip edges are found.
 */
function findStripEdges(
  data: Uint8ClampedArray, width: number, height: number,
  px: number, py: number,
  perpDx: number, perpDy: number,
  centerR: number, centerG: number, centerB: number,
  maxScan: number,
): { left: number; right: number } | null {
  const edgeThreshold = 40;
  const step = 2;

  // Find left edge: walk perpendicular until color jumps
  let leftDist = 0;
  let prevR = centerR, prevG = centerG, prevB = centerB;
  for (let d = step; d < maxScan; d += step) {
    const sx = Math.round(px + perpDx * d);
    const sy = Math.round(py + perpDy * d);
    if (sx < 2 || sy < 2 || sx >= width - 2 || sy >= height - 2) break;
    const [sr, sg, sb] = samplePatch(data, width, height, sx, sy, 1);
    const jump = colorDist(prevR, prevG, prevB, sr, sg, sb);
    if (jump > edgeThreshold) { leftDist = d; break; }
    prevR = sr; prevG = sg; prevB = sb;
    leftDist = d;
  }

  // Find right edge
  let rightDist = 0;
  prevR = centerR; prevG = centerG; prevB = centerB;
  for (let d = step; d < maxScan; d += step) {
    const sx = Math.round(px - perpDx * d);
    const sy = Math.round(py - perpDy * d);
    if (sx < 2 || sy < 2 || sx >= width - 2 || sy >= height - 2) break;
    const [sr, sg, sb] = samplePatch(data, width, height, sx, sy, 1);
    const jump = colorDist(prevR, prevG, prevB, sr, sg, sb);
    if (jump > edgeThreshold) { rightDist = d; break; }
    prevR = sr; prevG = sg; prevB = sb;
    rightDist = d;
  }

  // Must have found edges on both sides within a reasonable width
  if (leftDist < 4 || rightDist < 4) return null;
  return { left: leftDist, right: rightDist };
}

/**
 * Cast a ray along a direction, using perpendicular edge detection to
 * confirm we're still on a strip with clear edges. The strip ends when
 * the perpendicular edges disappear (no more contrast on the sides).
 */
function castRayWithEdges(
  data: Uint8ClampedArray, width: number, height: number,
  cx: number, cy: number, dx: number, dy: number,
  perpDx: number, perpDy: number,
  seedR: number, seedG: number, seedB: number,
  tolerance: number, maxDist: number,
  refWidth: number, // expected strip half-width from center measurement
): { dist: number; endX: number; endY: number } {
  const step = 4;
  let dist = 0, endX = cx, endY = cy;
  let rr = seedR, rg = seedG, rb = seedB;
  let missCount = 0;

  for (let d = step; d < maxDist; d += step) {
    const px = Math.round(cx + dx * d);
    const py = Math.round(cy + dy * d);
    if (px < 4 || py < 4 || px >= width - 4 || py >= height - 4) break;

    const [pr, pg, pb] = samplePatch(data, width, height, px, py, 2);

    // Color similarity check (generous — the edges do the real work)
    const distFromSeed = colorDist(seedR, seedG, seedB, pr, pg, pb);
    const distFromRolling = colorDist(rr, rg, rb, pr, pg, pb);
    if (Math.min(distFromSeed, distFromRolling) > tolerance * 1.3) break;

    // Check perpendicular edges every few steps
    if (d % 12 === 0 && refWidth > 6) {
      const edges = findStripEdges(data, width, height, px, py, perpDx, perpDy, pr, pg, pb, refWidth * 2);
      if (!edges) {
        missCount++;
        if (missCount >= 2) break; // Two consecutive misses = we've left the strip
      } else {
        missCount = 0;
        // Check that the detected width is reasonably close to the reference
        const totalW = edges.left + edges.right;
        if (totalW < refWidth * 0.3) {
          missCount++;
          if (missCount >= 2) break;
        }
      }
    }

    dist = d;
    endX = px;
    endY = py;
    rr = rr * 0.9 + pr * 0.1;
    rg = rg * 0.9 + pg * 0.1;
    rb = rb * 0.9 + pb * 0.1;
  }
  return { dist, endX, endY };
}

// --- Surface classification ---

function classifySurface(data: Uint8ClampedArray, mask: Uint8Array, _width: number): FieldDetection['surface'] {
  let totalH = 0, totalS = 0, totalL = 0, count = 0;
  for (let i = 0; i < mask.length; i += 16) {
    if (!mask[i]) continue;
    const { h, s, l } = rgbToHsl(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    totalH += h; totalS += s; totalL += l; count++;
    if (count > 10000) break;
  }
  if (count === 0) return 'unknown';
  const avgH = totalH / count, avgS = totalS / count, avgL = totalL / count;
  if (avgS < 0.08 && avgL >= 0.30 && avgL <= 0.70) return 'paved';
  if (avgH >= 60 && avgH <= 160 && avgS > 0.12) return 'grass';
  if (avgH >= 25 && avgH <= 55 && avgS > 0.08) return 'stubble';
  if (avgH >= 10 && avgH <= 35 && avgL < 0.45) return 'bare_earth';
  if (avgH >= 50 && avgH <= 100 && avgS > 0.05 && avgS <= 0.20) return 'crop';
  return 'mixed';
}

// --- Perimeter obstruction detection ---

const DIRECTIONS: Array<{ name: string; dx: number; dy: number }> = [
  { name: 'north', dx: 0, dy: -1 }, { name: 'northeast', dx: 1, dy: -1 },
  { name: 'east', dx: 1, dy: 0 }, { name: 'southeast', dx: 1, dy: 1 },
  { name: 'south', dx: 0, dy: 1 }, { name: 'southwest', dx: -1, dy: 1 },
  { name: 'west', dx: -1, dy: 0 }, { name: 'northwest', dx: -1, dy: -1 },
];

function classifyObstruction(r: number, g: number, b: number): 'trees' | 'building' | 'road' | 'water' | null {
  const { h, s, l } = rgbToHsl(r, g, b);
  if (h >= 60 && h <= 180 && l < 0.25 && s > 0.08) return 'trees';
  if (l < 0.12) return 'trees';
  if (l > 0.88) return 'building';
  if (h >= 180 && h <= 260 && s > 0.20) return 'water';
  if (s < 0.08 && l >= 0.25 && l <= 0.65) return 'road';
  return null;
}

function detectObstructions(
  data: Uint8ClampedArray, mask: Uint8Array,
  width: number, height: number, centerX: number, centerY: number,
): FieldDetection['obstructions'] {
  const obstructions: FieldDetection['obstructions'] = [];
  for (const dir of DIRECTIONS) {
    let lastFieldX = centerX, lastFieldY = centerY;
    for (let step = 5; step < 400; step += 3) {
      const x = Math.round(centerX + dir.dx * step);
      const y = Math.round(centerY + dir.dy * step);
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      if (mask[y * width + x]) { lastFieldX = x; lastFieldY = y; }
      else if (step > 20) break;
    }
    const sampleX = lastFieldX + dir.dx * 20;
    const sampleY = lastFieldY + dir.dy * 20;
    if (sampleX < 8 || sampleY < 8 || sampleX >= width - 8 || sampleY >= height - 8) continue;

    const typeCounts: Record<string, number> = {};
    for (let dy = -6; dy <= 6; dy += 2) {
      for (let dx = -6; dx <= 6; dx += 2) {
        const pi = ((sampleY + dy) * width + (sampleX + dx)) * 4;
        const t = classifyObstruction(data[pi], data[pi + 1], data[pi + 2]);
        if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
    }
    let maxCount = 0, maxType: string | null = null;
    for (const [t, c] of Object.entries(typeCounts)) {
      if (c > maxCount) { maxCount = c; maxType = t; }
    }
    if (maxType && maxCount > 15) {
      obstructions.push({
        type: maxType as FieldDetection['obstructions'][0]['type'],
        pixelPos: { x: sampleX, y: sampleY },
        direction: dir.name,
      });
    }
  }
  return obstructions;
}

// --- Runway rectangle from metadata ---

function buildRunwayRect(
  cx: number, cy: number,
  rwdir: number, rwlen: number, rwwidth: number,
  metersPerPx: number,
): Array<{ x: number; y: number }> {
  const halfLenPx = (rwlen / 2) / metersPerPx;
  const halfWidPx = ((rwwidth || rwlen * 0.06) / 2) / metersPerPx;
  const rad = (rwdir * Math.PI) / 180;
  const sinA = Math.sin(rad), cosA = Math.cos(rad);
  const e1x = cx + sinA * halfLenPx, e1y = cy - cosA * halfLenPx;
  const e2x = cx - sinA * halfLenPx, e2y = cy + cosA * halfLenPx;
  const perpSin = Math.sin(rad + Math.PI / 2);
  const perpCos = Math.cos(rad + Math.PI / 2);
  return [
    { x: e1x + perpSin * halfWidPx, y: e1y - perpCos * halfWidPx },
    { x: e1x - perpSin * halfWidPx, y: e1y + perpCos * halfWidPx },
    { x: e2x - perpSin * halfWidPx, y: e2y + perpCos * halfWidPx },
    { x: e2x + perpSin * halfWidPx, y: e2y - perpCos * halfWidPx },
  ];
}

function pointInPolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- Main detection ---

export function detectField(
  canvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  metersPerPx: number,
  runway?: RunwayHint,
): FieldDetection {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const rawCx = Math.round(Math.min(Math.max(centerX, 0), width - 1));
  const rawCy = Math.round(Math.min(Math.max(centerY, 0), height - 1));

  let boundaryPixels: Array<{ x: number; y: number }>;
  let centerPx: { x: number; y: number };
  let lengthM: number;
  let widthM: number;
  let orientationDeg: number;
  let fieldPixelCount: number;
  let mask: Uint8Array;

  if (runway && runway.rwdir > 0 && runway.rwlen > 0) {
    // --- Use .cup runway metadata directly ---
    const corners = buildRunwayRect(rawCx, rawCy, runway.rwdir, runway.rwlen, runway.rwwidth, metersPerPx);
    boundaryPixels = corners;
    centerPx = { x: rawCx, y: rawCy };
    lengthM = runway.rwlen;
    widthM = runway.rwwidth || Math.round(runway.rwlen * 0.06);
    orientationDeg = runway.rwdir > 180 ? runway.rwdir - 180 : runway.rwdir;
    fieldPixelCount = Math.round((runway.rwlen / metersPerPx) * (widthM / metersPerPx));

    mask = new Uint8Array(width * height);
    const minY = Math.max(0, Math.floor(Math.min(...corners.map(c => c.y))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...corners.map(c => c.y))));
    for (let y = minY; y <= maxY; y++) {
      const minX = Math.max(0, Math.floor(Math.min(...corners.map(c => c.x))));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(...corners.map(c => c.x))));
      for (let x = minX; x <= maxX; x++) {
        if (pointInPolygon(x, y, corners)) mask[y * width + x] = 1;
      }
    }
  } else {
    // --- CV edge-based detection for outlanding fields ---
    // Strategy: For each candidate direction, detect the strip by finding
    // parallel color edges (left and right boundaries) along perpendicular
    // cross-sections. The strip runs as long as those edges persist.

    const [seedR, seedG, seedB] = samplePatch(data, width, height, rawCx, rawCy, 6);
    const tolerance = 60;
    const maxRayDist = 500;

    // First pass: quick rays to find the best direction (longest color-similar run)
    let bestAngle = 0, bestQuickDist = 0;

    for (let angleDeg = 0; angleDeg < 180; angleDeg += 5) {
      const rad = (angleDeg * Math.PI) / 180;
      const dx = Math.sin(rad), dy = -Math.cos(rad);

      // Quick color-only ray in both directions
      let fwdD = 0, bwdD = 0;
      let rr = seedR, rg = seedG, rb = seedB;
      for (let d = 3; d < maxRayDist; d += 3) {
        const px = Math.round(rawCx + dx * d), py = Math.round(rawCy + dy * d);
        if (px < 3 || py < 3 || px >= width - 3 || py >= height - 3) break;
        const [pr, pg, pb] = samplePatch(data, width, height, px, py, 2);
        if (Math.min(colorDist(seedR, seedG, seedB, pr, pg, pb), colorDist(rr, rg, rb, pr, pg, pb)) > tolerance) break;
        fwdD = d;
        rr = rr * 0.9 + pr * 0.1; rg = rg * 0.9 + pg * 0.1; rb = rb * 0.9 + pb * 0.1;
      }
      rr = seedR; rg = seedG; rb = seedB;
      for (let d = 3; d < maxRayDist; d += 3) {
        const px = Math.round(rawCx - dx * d), py = Math.round(rawCy - dy * d);
        if (px < 3 || py < 3 || px >= width - 3 || py >= height - 3) break;
        const [pr, pg, pb] = samplePatch(data, width, height, px, py, 2);
        if (Math.min(colorDist(seedR, seedG, seedB, pr, pg, pb), colorDist(rr, rg, rb, pr, pg, pb)) > tolerance) break;
        bwdD = d;
        rr = rr * 0.9 + pr * 0.1; rg = rg * 0.9 + pg * 0.1; rb = rb * 0.9 + pb * 0.1;
      }

      if (fwdD + bwdD > bestQuickDist) {
        bestQuickDist = fwdD + bwdD;
        bestAngle = angleDeg;
      }
    }

    // Measure perpendicular strip width at center using edge detection
    const perpRad = ((bestAngle + 90) * Math.PI) / 180;
    const perpDx = Math.sin(perpRad), perpDy = -Math.cos(perpRad);
    const centerEdges = findStripEdges(data, width, height, rawCx, rawCy, perpDx, perpDy, seedR, seedG, seedB, 150);
    const refHalfWidth = centerEdges ? (centerEdges.left + centerEdges.right) / 2 : 30;
    const totalWidPx = centerEdges ? centerEdges.left + centerEdges.right : 0;

    // Second pass: refined rays with edge confirmation along the best direction
    const bestRad = (bestAngle * Math.PI) / 180;
    const bestDx = Math.sin(bestRad), bestDy = -Math.cos(bestRad);

    const bestFwd = castRayWithEdges(data, width, height, rawCx, rawCy,
      bestDx, bestDy, perpDx, perpDy,
      seedR, seedG, seedB, tolerance, maxRayDist, refHalfWidth);
    const bestBwd = castRayWithEdges(data, width, height, rawCx, rawCy,
      -bestDx, -bestDy, perpDx, perpDy,
      seedR, seedG, seedB, tolerance, maxRayDist, refHalfWidth);

    const bestTotalDist = bestFwd.dist + bestBwd.dist;

    // Build corners from the ray endpoints + perpendicular width
    const hw = Math.max(totalWidPx / 2, 10);
    const pSin = Math.sin(perpRad), pCos = -Math.cos(perpRad);

    const corners = [
      { x: bestFwd.endX + pSin * hw, y: bestFwd.endY + pCos * hw },
      { x: bestFwd.endX - pSin * hw, y: bestFwd.endY - pCos * hw },
      { x: bestBwd.endX - pSin * hw, y: bestBwd.endY - pCos * hw },
      { x: bestBwd.endX + pSin * hw, y: bestBwd.endY + pCos * hw },
    ];

    boundaryPixels = corners;
    centerPx = {
      x: (bestFwd.endX + bestBwd.endX) / 2,
      y: (bestFwd.endY + bestBwd.endY) / 2,
    };
    lengthM = Math.round(bestTotalDist * metersPerPx);
    widthM = Math.round(totalWidPx * metersPerPx);
    orientationDeg = Math.round(bestAngle);
    fieldPixelCount = bestTotalDist * Math.max(totalWidPx, 1);

    // Minimum usable length: 1000 ft = 305m
    // If detected length is less, flag it but still show what we found
    mask = new Uint8Array(width * height);
    const minMY = Math.max(0, Math.floor(Math.min(...corners.map(c => c.y))));
    const maxMY = Math.min(height - 1, Math.ceil(Math.max(...corners.map(c => c.y))));
    for (let my = minMY; my <= maxMY; my++) {
      const minMX = Math.max(0, Math.floor(Math.min(...corners.map(c => c.x))));
      const maxMX = Math.min(width - 1, Math.ceil(Math.max(...corners.map(c => c.x))));
      for (let mx = minMX; mx <= maxMX; mx++) {
        if (pointInPolygon(mx, my, corners)) mask[my * width + mx] = 1;
      }
    }
  }

  const surface = classifySurface(data, mask, width);
  const obstructions = detectObstructions(data, mask, width, height, rawCx, rawCy);

  return {
    boundaryPixels,
    centerPixel: centerPx,
    lengthM,
    widthM,
    orientationDeg,
    surface,
    obstructions,
    fieldPixelCount,
    areaSqM: Math.round(fieldPixelCount * metersPerPx * metersPerPx),
  };
}
