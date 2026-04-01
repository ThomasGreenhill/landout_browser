/**
 * Terrain elevation sampling for flatness analysis.
 * Uses the Open-Meteo elevation API (free, no key, CORS-enabled).
 */

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
