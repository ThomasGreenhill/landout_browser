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
