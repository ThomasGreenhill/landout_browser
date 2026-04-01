/**
 * Landing strip geometry computation.
 * No CV auto-detection — uses .cup metadata or user-drawn endpoints.
 */

export interface FieldDetection {
  boundaryPixels: Array<{ x: number; y: number }>;
  centerPixel: { x: number; y: number };
  lengthM: number;
  widthM: number;
  orientationDeg: number;
  surface: string;
  obstructions: Array<{
    type: string;
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

export interface DescriptionHints {
  headings?: [number, number];
  lengthFt?: number;
  lengthM?: number;
  notes: string[];
}

/**
 * Parse .cup description field for runway hints.
 * Patterns: "16/34", "E/W", "09/27 19D", "N/S 24A"
 */
export function parseDescriptionHints(desc: string): DescriptionHints {
  const hints: DescriptionHints = { notes: [] };
  if (!desc) return hints;

  // Runway headings: "16/34", "09/27", "01/19", "4/22"
  const hdgMatch = desc.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (hdgMatch) {
    const h1 = parseInt(hdgMatch[1], 10) * 10;
    const h2 = parseInt(hdgMatch[2], 10) * 10;
    if (h1 >= 0 && h1 <= 360 && h2 >= 0 && h2 <= 360) {
      hints.headings = [h1, h2];
    }
  }

  // Cardinal directions: "E/W", "N/S"
  if (!hints.headings) {
    if (/\bE\/W\b/i.test(desc)) hints.headings = [90, 270];
    else if (/\bN\/S\b/i.test(desc)) hints.headings = [0, 180];
    else if (/\bNE\/SW\b/i.test(desc) || /\bNE\b.*\bSW\b/i.test(desc)) hints.headings = [45, 225];
    else if (/\bNW\/SE\b/i.test(desc) || /\bNW\b.*\bSE\b/i.test(desc)) hints.headings = [315, 135];
  }

  // Length from alphanumeric codes: "34D" = 3400ft, "24A" = 2400ft, "60A" = 6000ft
  const lenMatch = desc.match(/\b(\d{2,3})[A-Z]\b/);
  if (lenMatch) {
    const lenHundreds = parseInt(lenMatch[1], 10);
    if (lenHundreds >= 5 && lenHundreds <= 200) {
      hints.lengthFt = lenHundreds * 100;
      hints.lengthM = Math.round(lenHundreds * 100 * 0.3048);
    }
  }

  // Landing direction hints
  if (/Land\s+To\s+(East|West|North|South|NE|NW|SE|SW)/i.test(desc)) {
    hints.notes.push(desc.match(/Land\s+To\s+\w+/i)![0]);
  }

  // Warning keywords
  if (/unsafe|unlandable|closed|restricted/i.test(desc)) {
    hints.notes.push('WARNING: ' + desc);
  }

  // Power lines, fences, obstructions
  if (/power\s*line/i.test(desc)) hints.notes.push('Power lines noted');
  if (/fence/i.test(desc)) hints.notes.push('Fence noted');
  if (/narrow/i.test(desc)) hints.notes.push('Narrow strip');

  return hints;
}

/**
 * Compute strip geometry from two endpoint clicks.
 */
export function computeStripFromEndpoints(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  widthM: number,
): { lengthM: number; orientationDeg: number; centerLat: number; centerLon: number } {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const latR1 = lat1 * Math.PI / 180;
  const latR2 = lat2 * Math.PI / 180;

  // Haversine distance
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(latR1) * Math.cos(latR2) * Math.sin(dLon / 2) ** 2;
  const lengthM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Bearing
  const y = Math.sin(dLon) * Math.cos(latR2);
  const x = Math.cos(latR1) * Math.sin(latR2) - Math.sin(latR1) * Math.cos(latR2) * Math.cos(dLon);
  let bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  if (bearing > 180) bearing -= 180; // normalize to 0-180

  void widthM;

  return {
    lengthM: Math.round(lengthM),
    orientationDeg: Math.round(bearing),
    centerLat: (lat1 + lat2) / 2,
    centerLon: (lon1 + lon2) / 2,
  };
}

/**
 * Build runway rectangle corners in pixel space from center + runway params.
 */
export function buildRunwayRect(
  cx: number, cy: number,
  rwdir: number, rwlen: number, rwwidth: number,
  metersPerPx: number,
): Array<{ x: number; y: number }> {
  const halfLenPx = (rwlen / 2) / metersPerPx;
  const halfWidPx = ((rwwidth || Math.max(rwlen * 0.04, 15)) / 2) / metersPerPx;
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

/**
 * Build runway rectangle from two endpoint lat/lons.
 */
export function buildStripRectFromEndpoints(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  widthM: number,
  wpLat: number, wpLon: number,
  metersPerPx: number,
  waypointPixel: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const R = 6371000;

  function latLonToPixel(lat: number, lon: number): { x: number; y: number } {
    const dLat = (lat - wpLat) * Math.PI / 180;
    const dLon = (lon - wpLon) * Math.PI / 180;
    const latRad = wpLat * Math.PI / 180;
    const dy = dLat * R;
    const dx = dLon * R * Math.cos(latRad);
    return {
      x: waypointPixel.x + dx / metersPerPx,
      y: waypointPixel.y - dy / metersPerPx,
    };
  }

  const p1 = latLonToPixel(lat1, lon1);
  const p2 = latLonToPixel(lat2, lon2);
  const halfW = (widthM / 2) / metersPerPx;

  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return [p1, p1, p2, p2]; // degenerate

  const perpX = (-dy / len) * halfW;
  const perpY = (dx / len) * halfW;

  return [
    { x: p1.x + perpX, y: p1.y + perpY },
    { x: p1.x - perpX, y: p1.y - perpY },
    { x: p2.x - perpX, y: p2.y - perpY },
    { x: p2.x + perpX, y: p2.y + perpY },
  ];
}
