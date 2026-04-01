import { Waypoint, WaypointStyle } from './types';
import { parseCupCoord } from './geo-utils';

/**
 * Split a CSV line respecting quoted fields.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse elevation string like "507.0m" or "1200ft" to meters.
 */
function parseElevation(raw: string): number {
  if (!raw) return 0;
  const lower = raw.toLowerCase().trim();
  if (lower.endsWith('ft')) {
    return parseFloat(lower) * 0.3048;
  }
  return parseFloat(lower) || 0;
}

/**
 * Parse runway length string like "850m" or "2800ft" to meters.
 */
function parseLength(raw: string): number {
  return parseElevation(raw);
}

/**
 * Parse a .cup file into an array of Waypoints.
 */
export function parseCupFile(text: string): Waypoint[] {
  const lines = text.split(/\r?\n/);
  const waypoints: Waypoint[] = [];
  let headerSkipped = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Stop at task section
    if (trimmed.startsWith('-----') || trimmed.toLowerCase().includes('related tasks')) {
      break;
    }

    // Skip header row
    if (!headerSkipped) {
      if (trimmed.toLowerCase().startsWith('name,') || trimmed.toLowerCase().startsWith('"name"')) {
        headerSkipped = true;
        continue;
      }
      headerSkipped = true;
    }

    const fields = splitCsvLine(trimmed);
    if (fields.length < 6) {
      continue;
    }

    const styleNum = parseInt(fields[5], 10);
    const style = Object.values(WaypointStyle).includes(styleNum)
      ? (styleNum as WaypointStyle)
      : WaypointStyle.Unknown;

    try {
      const wp: Waypoint = {
        name: fields[0] || '',
        code: fields[1] || '',
        country: fields[2] || '',
        lat: parseCupCoord(fields[3]),
        lon: parseCupCoord(fields[4]),
        elev: parseElevation(fields[6] || ''),
        style,
        rwdir: parseInt(fields[7] || '0', 10) || 0,
        rwlen: parseLength(fields[8] || ''),
        rwwidth: parseLength(fields[9] || ''),
        freq: fields[10] || '',
        desc: fields[11] || '',
      };

      if (isNaN(wp.lat) || isNaN(wp.lon)) {
        console.warn('Skipping waypoint with invalid coordinates:', fields[0]);
        continue;
      }

      waypoints.push(wp);
    } catch (e) {
      console.warn('Skipping malformed line:', trimmed, e);
    }
  }

  return waypoints;
}
