/**
 * Client-side computer vision for detecting landing fields in satellite imagery.
 * Uses a "magic wand" color-similarity flood fill from the waypoint center.
 * No absolute color thresholds — works on any terrain type.
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

/** Euclidean color distance in RGB space (0-441) */
function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Sample average color in a small patch around a point.
 * This smooths out noise and JPEG artifacts.
 */
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
  return [tr / count, tg / count, tb / count];
}

/**
 * Search near the start point for the darkest patch (most likely pavement/runway).
 * Returns the pixel coordinates of the darkest area found.
 */
function findDarkestNearby(
  data: Uint8ClampedArray, width: number, height: number,
  cx: number, cy: number, searchRadius: number,
): { x: number; y: number } {
  let darkestL = 1.0;
  let bestX = cx, bestY = cy;
  const step = 8;

  for (let dy = -searchRadius; dy <= searchRadius; dy += step) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += step) {
      const x = cx + dx, y = cy + dy;
      if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4) continue;
      const [pr, pg, pb] = samplePatch(data, width, height, x, y, 4);
      const { l } = rgbToHsl(pr, pg, pb);
      // Prefer darker areas but not pure black (shadows)
      if (l < darkestL && l > 0.08) {
        darkestL = l;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY };
}

/**
 * Magic-wand style flood fill: finds all connected pixels similar in color
 * to the seed region. Works on a downsampled grid for speed.
 */
function similarityFloodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
): Uint8Array {
  const S = 4; // downsample factor
  const gw = Math.ceil(width / S);
  const gh = Math.ceil(height / S);

  // Sample the seed color from a patch around the start point
  const [seedR, seedG, seedB] = samplePatch(data, width, height, startX, startY, 8);

  // Build downsampled color grid
  const gridR = new Float32Array(gw * gh);
  const gridG = new Float32Array(gw * gh);
  const gridB = new Float32Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const [r, g, b] = samplePatch(data, width, height, gx * S, gy * S, 2);
      const gi = gy * gw + gx;
      gridR[gi] = r; gridG[gi] = g; gridB[gi] = b;
    }
  }

  // Find start in grid space
  let gsx = Math.round(startX / S), gsy = Math.round(startY / S);
  gsx = Math.min(Math.max(gsx, 0), gw - 1);
  gsy = Math.min(Math.max(gsy, 0), gh - 1);

  // Flood fill by color similarity to the seed color
  const visited = new Uint8Array(gw * gh);
  const stack: number[] = [gsy * gw + gsx];
  visited[gsy * gw + gsx] = 1;

  while (stack.length > 0) {
    const ci = stack.pop()!;
    const cx = ci % gw;
    const cy = (ci - cx) / gw;

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const ni = ny * gw + nx;
      if (visited[ni]) continue;

      const dist = colorDist(seedR, seedG, seedB, gridR[ni], gridG[ni], gridB[ni]);
      if (dist < tolerance) {
        visited[ni] = 1;
        stack.push(ni);
      }
    }
  }

  // Expand to full resolution mask
  const mask = new Uint8Array(width * height);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!visited[gy * gw + gx]) continue;
      for (let dy = 0; dy < S && gy * S + dy < height; dy++) {
        for (let dx = 0; dx < S && gx * S + dx < width; dx++) {
          mask[(gy * S + dy) * width + (gx * S + dx)] = 1;
        }
      }
    }
  }

  return mask;
}

// --- Convex hull (Andrew's monotone chain) ---

function convexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return points;
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// --- Minimum bounding rectangle ---

function minBoundingRect(hull: Array<{ x: number; y: number }>): {
  center: { x: number; y: number }; width: number; height: number; angle: number;
} {
  if (hull.length < 2) return { center: hull[0] || { x: 0, y: 0 }, width: 0, height: 0, angle: 0 };

  let minArea = Infinity;
  let best = { center: { x: 0, y: 0 }, width: 0, height: 0, angle: 0 };

  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    const edgeAngle = Math.atan2(hull[j].y - hull[i].y, hull[j].x - hull[i].x);
    const cos = Math.cos(-edgeAngle), sin = Math.sin(-edgeAngle);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.y * sin;
      const ry = p.x * sin + p.y * cos;
      minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < minArea) {
      minArea = area;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const cos2 = Math.cos(edgeAngle), sin2 = Math.sin(edgeAngle);
      best = {
        center: { x: cx * cos2 - cy * sin2, y: cx * sin2 + cy * cos2 },
        width: maxX - minX, height: maxY - minY, angle: edgeAngle,
      };
    }
  }
  return best;
}

// --- Surface classification ---

function classifySurface(data: Uint8ClampedArray, mask: Uint8Array, width: number): FieldDetection['surface'] {
  let totalH = 0, totalS = 0, totalL = 0, count = 0;
  void width;
  for (let i = 0; i < mask.length; i += 16) { // sparse sample
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
      if (mask[y * width + x]) {
        lastFieldX = x; lastFieldY = y;
      } else if (step > 20) {
        break;
      }
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

// --- Runway metadata from .cup file ---

export interface RunwayHint {
  /** Runway direction in degrees (0-360) */
  rwdir: number;
  /** Runway length in meters */
  rwlen: number;
  /** Runway width in meters (0 if unknown) */
  rwwidth: number;
}

/**
 * Build a runway rectangle from known metadata.
 * Returns corner points in pixel coordinates.
 */
function buildRunwayRect(
  cx: number, cy: number,
  rwdir: number, rwlen: number, rwwidth: number,
  metersPerPx: number,
): Array<{ x: number; y: number }> {
  const halfLenPx = (rwlen / 2) / metersPerPx;
  const halfWidPx = ((rwwidth || rwlen * 0.06) / 2) / metersPerPx; // default width ~6% of length
  // Convert runway heading to canvas angle (0°=north=up, clockwise)
  const rad = (rwdir * Math.PI) / 180;
  const sinA = Math.sin(rad), cosA = Math.cos(rad);

  // Runway endpoints along the heading
  const e1x = cx + sinA * halfLenPx, e1y = cy - cosA * halfLenPx;
  const e2x = cx - sinA * halfLenPx, e2y = cy + cosA * halfLenPx;

  // Perpendicular offset for width
  const perpSin = Math.sin(rad + Math.PI / 2);
  const perpCos = Math.cos(rad + Math.PI / 2);

  return [
    { x: e1x + perpSin * halfWidPx, y: e1y - perpCos * halfWidPx },
    { x: e1x - perpSin * halfWidPx, y: e1y + perpCos * halfWidPx },
    { x: e2x - perpSin * halfWidPx, y: e2y + perpCos * halfWidPx },
    { x: e2x + perpSin * halfWidPx, y: e2y - perpCos * halfWidPx },
  ];
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

    // Build mask from the rectangle for surface/obstruction analysis
    mask = new Uint8Array(width * height);
    // Simple scanline fill of the rotated rectangle
    const minY = Math.max(0, Math.floor(Math.min(...corners.map(c => c.y))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...corners.map(c => c.y))));
    for (let y = minY; y <= maxY; y++) {
      const minX = Math.max(0, Math.floor(Math.min(...corners.map(c => c.x))));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(...corners.map(c => c.x))));
      for (let x = minX; x <= maxX; x++) {
        if (pointInPolygon(x, y, corners)) {
          mask[y * width + x] = 1;
        }
      }
    }
  } else {
    // --- CV-based detection for outlanding fields ---
    const dark = findDarkestNearby(data, width, height, rawCx, rawCy, 80);
    const cx = dark.x, cy = dark.y;

    let bestMask: Uint8Array | null = null;
    let bestCount = 0;
    const minFP = 100, maxFP = (width * height) / 4;

    for (const tol of [30, 40, 50, 60, 70]) {
      const m = similarityFloodFill(data, width, height, cx, cy, tol);
      let count = 0;
      for (let i = 0; i < m.length; i += 16) { if (m[i]) count++; }
      count *= 16;
      if (count >= minFP && count <= maxFP) {
        if (!bestMask || count > bestCount) { bestMask = m; bestCount = count; }
        if (count > minFP * 10) break;
      }
    }
    if (!bestMask) {
      bestMask = similarityFloodFill(data, width, height, cx, cy, 50);
      for (let i = 0; i < bestMask.length; i += 16) { if (bestMask[i]) bestCount++; }
      bestCount *= 16;
    }
    mask = bestMask;

    // Collect boundary pixels
    const bPoints: Array<{ x: number; y: number }> = [];
    let fpCount = 0;
    for (let py = 0; py < height; py += 4) {
      for (let px = 0; px < width; px += 4) {
        if (!mask[py * width + px]) continue;
        fpCount++;
        for (const [dx, dy] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
            bPoints.push({ x: px, y: py }); break;
          }
        }
      }
    }

    let hullInput = bPoints;
    if (hullInput.length > 2000) {
      const step = Math.ceil(hullInput.length / 2000);
      hullInput = hullInput.filter((_, i) => i % step === 0);
    }
    const hull = convexHull(hullInput);
    const rect = minBoundingRect(hull);

    const lPx = Math.max(rect.width, rect.height);
    const wPx = Math.min(rect.width, rect.height);
    let angle = rect.angle;
    if (rect.height > rect.width) angle += Math.PI / 2;
    let bearing = (90 - (angle * 180) / Math.PI) % 360;
    if (bearing < 0) bearing += 360;
    if (bearing > 180) bearing -= 180;

    boundaryPixels = hull.length > 50
      ? hull.filter((_, i) => i % Math.ceil(hull.length / 50) === 0)
      : hull;
    centerPx = rect.center;
    lengthM = Math.round(lPx * metersPerPx);
    widthM = Math.round(wPx * metersPerPx);
    orientationDeg = Math.round(bearing);
    fieldPixelCount = fpCount * 16;
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

/** Point-in-polygon test (ray casting) */
function pointInPolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
