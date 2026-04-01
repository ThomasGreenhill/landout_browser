/**
 * Client-side computer vision for detecting landing fields in satellite imagery.
 * Pure canvas pixel analysis — no AI, runs in milliseconds.
 */

export interface FieldDetection {
  /** Convex hull of the detected field in pixel coordinates */
  boundaryPixels: Array<{ x: number; y: number }>;
  /** Center of the detected field in pixels */
  centerPixel: { x: number; y: number };
  /** Field dimensions in meters */
  lengthM: number;
  widthM: number;
  /** Runway/field orientation in degrees (0=north, clockwise) */
  orientationDeg: number;
  /** Detected surface type */
  surface: 'grass' | 'crop' | 'stubble' | 'bare_earth' | 'paved' | 'mixed' | 'unknown';
  /** Detected obstructions at field perimeter */
  obstructions: Array<{
    type: 'trees' | 'building' | 'road' | 'water' | 'other';
    pixelPos: { x: number; y: number };
    direction: string;
  }>;
  /** Number of field pixels found (for confidence) */
  fieldPixelCount: number;
  /** Total area in square meters */
  areaSqM: number;
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

function isFieldPixel(r: number, g: number, b: number): boolean {
  const { h, s, l } = rgbToHsl(r, g, b);

  // Too dark (shadows, water, dense trees) or too bright (buildings, concrete)
  if (l < 0.12 || l > 0.88) return false;

  // Green vegetation — grass, crops
  if (h >= 50 && h <= 170 && s > 0.08 && l >= 0.15 && l <= 0.75) return true;

  // Brown/tan — dry grass, stubble, bare earth
  if (h >= 20 && h <= 55 && l >= 0.20 && l <= 0.70) return true;

  // Muted/unsaturated earth tones
  if (s < 0.35 && l >= 0.25 && l <= 0.65) return true;

  return false;
}

function classifyObstruction(r: number, g: number, b: number): 'trees' | 'building' | 'road' | 'water' | null {
  const { h, s, l } = rgbToHsl(r, g, b);

  // Very dark green = trees/dense vegetation
  if (h >= 60 && h <= 180 && l < 0.25 && s > 0.1) return 'trees';

  // Dark overall = trees or shadow
  if (l < 0.15) return 'trees';

  // Very bright = buildings/structures
  if (l > 0.85) return 'building';

  // Blue = water
  if (h >= 180 && h <= 260 && s > 0.25) return 'water';

  // Gray, low saturation = road/pavement
  if (s < 0.1 && l >= 0.3 && l <= 0.7) return 'road';

  return null;
}

// --- Region growing ---

function floodFillField(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
): Uint8Array {
  const mask = new Uint8Array(width * height); // 1 = field
  const stack: number[] = [];
  const idx = startY * width + startX;

  if (!isFieldPixel(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2])) {
    // Start point isn't a field pixel — search nearby for one
    let found = false;
    for (let r = 1; r < 30 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const nx = startX + dx, ny = startY + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (isFieldPixel(data[ni * 4], data[ni * 4 + 1], data[ni * 4 + 2])) {
            stack.push(ni);
            mask[ni] = 1;
            found = true;
          }
        }
      }
    }
    if (!found) return mask;
  } else {
    stack.push(idx);
    mask[idx] = 1;
  }

  // Flood fill with step size for performance (check every 2nd pixel)
  const step = 2;
  while (stack.length > 0) {
    const ci = stack.pop()!;
    const cx = ci % width;
    const cy = (ci - cx) / width;

    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (mask[ni]) continue;
      if (isFieldPixel(data[ni * 4], data[ni * 4 + 1], data[ni * 4 + 2])) {
        mask[ni] = 1;
        stack.push(ni);
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

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// --- Minimum bounding rectangle ---

function minBoundingRect(hull: Array<{ x: number; y: number }>): {
  center: { x: number; y: number };
  width: number;
  height: number;
  angle: number; // radians
} {
  if (hull.length < 2) {
    return { center: hull[0] || { x: 0, y: 0 }, width: 0, height: 0, angle: 0 };
  }

  let minArea = Infinity;
  let best = { center: { x: 0, y: 0 }, width: 0, height: 0, angle: 0 };

  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    const edgeAngle = Math.atan2(hull[j].y - hull[i].y, hull[j].x - hull[i].x);
    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.y * sin;
      const ry = p.x * sin + p.y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }

    const area = (maxX - minX) * (maxY - minY);
    if (area < minArea) {
      minArea = area;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      // Rotate center back
      const cos2 = Math.cos(edgeAngle);
      const sin2 = Math.sin(edgeAngle);
      best = {
        center: { x: cx * cos2 - cy * sin2, y: cx * sin2 + cy * cos2 },
        width: maxX - minX,
        height: maxY - minY,
        angle: edgeAngle,
      };
    }
  }

  return best;
}

// --- Surface classification ---

function classifySurface(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
): 'grass' | 'crop' | 'stubble' | 'bare_earth' | 'paved' | 'mixed' | 'unknown' {
  let totalH = 0, totalS = 0, totalL = 0, count = 0;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const { h, s, l } = rgbToHsl(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    totalH += h; totalS += s; totalL += l;
    count++;
    if (count > 50000) break; // sample cap for speed
  }

  if (count === 0) return 'unknown';
  const avgH = totalH / count;
  const avgS = totalS / count;
  const avgL = totalL / count;

  // Use void to suppress lint for width
  void width;

  if (avgS < 0.08 && avgL >= 0.35 && avgL <= 0.65) return 'paved';
  if (avgH >= 60 && avgH <= 160 && avgS > 0.15) return 'grass';
  if (avgH >= 30 && avgH <= 60 && avgS > 0.1) return 'stubble';
  if (avgH >= 15 && avgH <= 40 && avgL < 0.40) return 'bare_earth';
  if (avgH >= 50 && avgH <= 100 && avgS > 0.08 && avgS <= 0.25) return 'crop';
  return 'mixed';
}

// --- Perimeter obstruction detection ---

const DIRECTIONS: Array<{ name: string; dx: number; dy: number }> = [
  { name: 'north', dx: 0, dy: -1 },
  { name: 'northeast', dx: 1, dy: -1 },
  { name: 'east', dx: 1, dy: 0 },
  { name: 'southeast', dx: 1, dy: 1 },
  { name: 'south', dx: 0, dy: 1 },
  { name: 'southwest', dx: -1, dy: 1 },
  { name: 'west', dx: -1, dy: 0 },
  { name: 'northwest', dx: -1, dy: -1 },
];

function detectObstructions(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
): FieldDetection['obstructions'] {
  const obstructions: FieldDetection['obstructions'] = [];

  // For each direction, walk outward from center until we leave the field,
  // then sample a patch just outside and classify it
  for (const dir of DIRECTIONS) {
    let x = centerX, y = centerY;
    let lastFieldX = x, lastFieldY = y;

    // Walk outward
    for (let step = 0; step < 500; step++) {
      x = Math.round(centerX + dir.dx * step * 3);
      y = Math.round(centerY + dir.dy * step * 3);
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      const idx = y * width + x;
      if (mask[idx]) {
        lastFieldX = x;
        lastFieldY = y;
      } else if (step > 5) {
        // We've left the field — sample this area
        break;
      }
    }

    // Sample a 10x10 patch just outside the field edge
    const sampleX = lastFieldX + dir.dx * 15;
    const sampleY = lastFieldY + dir.dy * 15;
    if (sampleX < 5 || sampleY < 5 || sampleX >= width - 5 || sampleY >= height - 5) continue;

    const typeCounts: Record<string, number> = {};
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const px = sampleX + dx, py = sampleY + dy;
        const pi = (py * width + px) * 4;
        const t = classifyObstruction(data[pi], data[pi + 1], data[pi + 2]);
        if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
    }

    // Find dominant obstruction type
    let maxCount = 0, maxType: string | null = null;
    for (const [t, c] of Object.entries(typeCounts)) {
      if (c > maxCount) { maxCount = c; maxType = t; }
    }

    if (maxType && maxCount > 30) {
      obstructions.push({
        type: maxType as FieldDetection['obstructions'][0]['type'],
        pixelPos: { x: sampleX, y: sampleY },
        direction: dir.name,
      });
    }
  }

  return obstructions;
}

// --- Main detection function ---

/**
 * Detect the landing field in a satellite image canvas.
 * Runs entirely on the client in ~50-200ms.
 *
 * @param canvas - The full-resolution composite canvas (before downscale)
 * @param centerX - Waypoint pixel X in the canvas
 * @param centerY - Waypoint pixel Y in the canvas
 * @param metersPerPx - Scale factor (meters per pixel)
 */
export function detectField(
  canvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  metersPerPx: number,
): FieldDetection {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // 1. Flood fill from center to find connected field region
  const cx = Math.round(Math.min(Math.max(centerX, 0), width - 1));
  const cy = Math.round(Math.min(Math.max(centerY, 0), height - 1));
  const mask = floodFillField(data, width, height, cx, cy);

  // 2. Collect field boundary pixels (subsample for performance)
  const boundaryPoints: Array<{ x: number; y: number }> = [];
  let fieldPixelCount = 0;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (!mask[y * width + x]) continue;
      fieldPixelCount++;

      // Check if this is a boundary pixel (has a non-field neighbor)
      let isBoundary = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
          isBoundary = true;
          break;
        }
      }
      if (isBoundary) {
        boundaryPoints.push({ x, y });
      }
    }
  }

  // Subsample boundary for hull computation (max 2000 points)
  let hullInput = boundaryPoints;
  if (hullInput.length > 2000) {
    const step = Math.ceil(hullInput.length / 2000);
    hullInput = hullInput.filter((_, i) => i % step === 0);
  }

  // 3. Convex hull
  const hull = convexHull(hullInput);

  // 4. Minimum bounding rectangle
  const rect = minBoundingRect(hull);

  // Ensure length > width
  let lengthPx = Math.max(rect.width, rect.height);
  let widthPx = Math.min(rect.width, rect.height);
  let angle = rect.angle;
  if (rect.height > rect.width) {
    angle += Math.PI / 2;
  }

  // Convert angle to compass bearing (0=north, clockwise)
  let bearingDeg = (90 - (angle * 180) / Math.PI) % 360;
  if (bearingDeg < 0) bearingDeg += 360;
  // Normalize to 0-180 (runway can be used in both directions)
  if (bearingDeg > 180) bearingDeg -= 180;

  // 5. Surface classification
  const surface = classifySurface(data, mask, width);

  // 6. Perimeter obstruction detection
  const obstructions = detectObstructions(data, mask, width, height, cx, cy);

  // Subsample hull for output (max 50 points)
  let outputHull = hull;
  if (outputHull.length > 50) {
    const step = Math.ceil(outputHull.length / 50);
    outputHull = outputHull.filter((_, i) => i % step === 0);
  }

  const areaSqM = fieldPixelCount * 4 * metersPerPx * metersPerPx; // *4 because we step by 2

  return {
    boundaryPixels: outputHull,
    centerPixel: rect.center,
    lengthM: Math.round(lengthPx * metersPerPx),
    widthM: Math.round(widthPx * metersPerPx),
    orientationDeg: Math.round(bearingDeg),
    surface,
    obstructions,
    fieldPixelCount: fieldPixelCount * 4,
    areaSqM: Math.round(areaSqM),
  };
}
