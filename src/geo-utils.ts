/**
 * Parse a CUP coordinate string to decimal degrees.
 * Latitude format:  DDMMmmmN/S  (e.g. "4624.317N")
 * Longitude format: DDDMMmmmE/W (e.g. "01410.700E")
 */
export function parseCupCoord(raw: string): number {
  const trimmed = raw.trim();
  const hemisphere = trimmed.slice(-1).toUpperCase();
  const numeric = trimmed.slice(0, -1);

  let degrees: number;
  let minutes: number;

  if (hemisphere === 'N' || hemisphere === 'S') {
    degrees = parseInt(numeric.slice(0, 2), 10);
    minutes = parseFloat(numeric.slice(2));
  } else {
    degrees = parseInt(numeric.slice(0, 3), 10);
    minutes = parseFloat(numeric.slice(3));
  }

  const decimal = degrees + minutes / 60;
  return hemisphere === 'S' || hemisphere === 'W' ? -decimal : decimal;
}

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Calculate the great-circle distance between two points using the haversine formula.
 * Returns distance in kilometers.
 */
export function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculate the initial bearing from point 1 to point 2.
 * Returns bearing in degrees (0-360).
 */
export function bearing(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x =
    Math.cos(rLat1) * Math.sin(rLat2) -
    Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const CARDINAL_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Convert a bearing in degrees to an 8-point cardinal direction.
 */
export function cardinalDirection(deg: number): string {
  const index = Math.round(deg / 45) % 8;
  return CARDINAL_DIRS[index];
}
