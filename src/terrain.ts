/**
 * Terrain elevation sampling for flatness analysis.
 * Uses the Open-Meteo elevation API (free, no key, CORS-enabled).
 */

/**
 * Offset a lat/lon by a distance and bearing.
 */
function offsetPoint(lat: number, lon: number, distM: number, bearingDeg: number): { lat: number; lon: number } {
  const R = 6371000;
  const brng = (bearingDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const d = distM / R;
  const lat2 = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brng));
  const lon2 = lonR + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

export interface ElevationProfile {
  /** Elevation samples along the strip in meters MSL */
  samples: Array<{ lat: number; lon: number; elevM: number; distM: number }>;
  /** Maximum elevation change across the strip */
  maxSlopePercent: number;
  /** Average slope in percent */
  avgSlopePercent: number;
  /** Whether the terrain is flat enough for landing (< 3% average slope) */
  isFlat: boolean;
}

/**
 * Fetch elevations for a list of coordinates.
 * Uses Open-Meteo elevation API (free, no key needed).
 */
async function fetchElevations(points: Array<{ lat: number; lon: number }>): Promise<number[]> {
  const lats = points.map(p => p.lat.toFixed(6)).join(',');
  const lons = points.map(p => p.lon.toFixed(6)).join(',');
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Elevation API error: ${resp.status}`);
  const data = await resp.json();
  return data.elevation as number[];
}

/**
 * Sample elevation along a strip and compute slope profile.
 *
 * @param centerLat - Center of the strip
 * @param centerLon - Center of the strip
 * @param orientationDeg - Strip direction (0=north, clockwise)
 * @param lengthM - Total strip length in meters
 * @param numSamples - Number of elevation points to sample (default 10)
 */
export async function getElevationProfile(
  centerLat: number,
  centerLon: number,
  orientationDeg: number,
  lengthM: number,
  numSamples = 10,
): Promise<ElevationProfile> {
  const R = 6371000;
  const halfLen = lengthM / 2;
  const rad = (orientationDeg * Math.PI) / 180;

  // Generate sample points along the strip
  const points: Array<{ lat: number; lon: number; distM: number }> = [];
  for (let i = 0; i < numSamples; i++) {
    const distFromCenter = -halfLen + (i / (numSamples - 1)) * lengthM;
    const latR = (centerLat * Math.PI) / 180;
    const lonR = (centerLon * Math.PI) / 180;
    const brng = distFromCenter >= 0 ? rad : rad + Math.PI;
    const d = Math.abs(distFromCenter) / R;

    const lat2 = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brng));
    const lon2 = lonR + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(lat2));

    points.push({
      lat: (lat2 * 180) / Math.PI,
      lon: (lon2 * 180) / Math.PI,
      distM: distFromCenter + halfLen, // 0 = start, lengthM = end
    });
  }

  const elevations = await fetchElevations(points);

  const samples = points.map((p, i) => ({
    lat: p.lat,
    lon: p.lon,
    elevM: elevations[i],
    distM: p.distM,
  }));

  // Compute slopes between adjacent samples
  let maxSlope = 0;
  let totalSlope = 0;
  for (let i = 1; i < samples.length; i++) {
    const dElev = Math.abs(samples[i].elevM - samples[i - 1].elevM);
    const dDist = samples[i].distM - samples[i - 1].distM;
    const slope = dDist > 0 ? (dElev / dDist) * 100 : 0;
    if (slope > maxSlope) maxSlope = slope;
    totalSlope += slope;
  }
  const avgSlope = totalSlope / Math.max(samples.length - 1, 1);

  return {
    samples,
    maxSlopePercent: Math.round(maxSlope * 10) / 10,
    avgSlopePercent: Math.round(avgSlope * 10) / 10,
    isFlat: avgSlope < 3,
  };
}

/**
 * Check how far in each direction from a center point the terrain stays
 * flat (slope < maxSlopePercent). Returns the safe distance in each direction.
 *
 * Samples elevation every `stepM` meters along the bearing.
 * Returns the max forward and backward distances before slope exceeds threshold.
 */
export async function getTerrainSafeDistances(
  centerLat: number,
  centerLon: number,
  bearingDeg: number,
  maxDistM: number,
  stepM = 50,
  maxSlopePercent = 5,
): Promise<{ fwdDistM: number; bwdDistM: number }> {
  const numSteps = Math.ceil(maxDistM / stepM);

  // Generate sample points: forward and backward
  const fwdPoints: Array<{ lat: number; lon: number }> = [];
  const bwdPoints: Array<{ lat: number; lon: number }> = [];

  fwdPoints.push({ lat: centerLat, lon: centerLon });
  bwdPoints.push({ lat: centerLat, lon: centerLon });

  for (let i = 1; i <= numSteps; i++) {
    fwdPoints.push(offsetPoint(centerLat, centerLon, i * stepM, bearingDeg));
    bwdPoints.push(offsetPoint(centerLat, centerLon, i * stepM, (bearingDeg + 180) % 360));
  }

  // Fetch all elevations in one batch
  const allPoints = [...fwdPoints, ...bwdPoints.slice(1)]; // avoid duplicate center
  let elevations: number[];
  try {
    elevations = await fetchElevations(allPoints);
  } catch {
    // If elevation API fails, don't constrain the detection
    return { fwdDistM: maxDistM, bwdDistM: maxDistM };
  }

  const fwdElevs = elevations.slice(0, fwdPoints.length);
  const bwdElevs = [elevations[0], ...elevations.slice(fwdPoints.length)];

  // Walk forward until slope exceeds threshold
  let fwdDistM = 0;
  for (let i = 1; i < fwdElevs.length; i++) {
    const dElev = Math.abs(fwdElevs[i] - fwdElevs[i - 1]);
    const slope = (dElev / stepM) * 100;
    if (slope > maxSlopePercent) break;
    fwdDistM = i * stepM;
  }

  // Walk backward
  let bwdDistM = 0;
  for (let i = 1; i < bwdElevs.length; i++) {
    const dElev = Math.abs(bwdElevs[i] - bwdElevs[i - 1]);
    const slope = (dElev / stepM) * 100;
    if (slope > maxSlopePercent) break;
    bwdDistM = i * stepM;
  }

  return { fwdDistM, bwdDistM };
}
