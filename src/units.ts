export type UnitSystem = 'metric' | 'imperial' | 'aviation';

const STORAGE_KEY = 'landout-units';

// Metric: m, km
// Imperial: ft, mi
// Aviation: ft (altitude), nm (distance), m (runway)

export function getUnitSystem(): UnitSystem {
  return (localStorage.getItem(STORAGE_KEY) as UnitSystem) || 'metric';
}

export function setUnitSystem(system: UnitSystem): void {
  localStorage.setItem(STORAGE_KEY, system);
}

/** Format an elevation (stored in meters) for display. */
export function fmtElev(meters: number): string {
  const sys = getUnitSystem();
  if (sys === 'metric') {
    return `${Math.round(meters)} m`;
  }
  // Imperial and aviation both use feet for altitude
  return `${Math.round(meters * 3.28084)} ft`;
}

/** Format a short distance like runway length (stored in meters). */
export function fmtShortDist(meters: number): string {
  const sys = getUnitSystem();
  if (sys === 'imperial') {
    return `${Math.round(meters * 3.28084)} ft`;
  }
  // Metric and aviation both use meters for runway lengths
  return `${Math.round(meters)} m`;
}

/** Format a long distance (stored in km) for display. */
export function fmtDist(km: number): string {
  const sys = getUnitSystem();
  if (sys === 'imperial') {
    return `${(km * 0.621371).toFixed(1)} mi`;
  }
  if (sys === 'aviation') {
    return `${(km * 0.539957).toFixed(1)} nm`;
  }
  return `${km.toFixed(1)} km`;
}

/** Format a distance in meters for the measure tool / tape labels. */
export function fmtMeasure(meters: number): string {
  const sys = getUnitSystem();
  if (sys === 'imperial') {
    if (meters >= 1609.34) {
      return `${(meters / 1609.34).toFixed(2)} mi`;
    }
    return `${Math.round(meters * 3.28084)} ft`;
  }
  if (sys === 'aviation') {
    if (meters >= 1852) {
      return `${(meters / 1852).toFixed(2)} nm`;
    }
    return `${Math.round(meters)} m`;
  }
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

/** Get the unit label for the distance slider. */
export function distSliderUnit(): string {
  const sys = getUnitSystem();
  if (sys === 'imperial') return 'mi';
  if (sys === 'aviation') return 'nm';
  return 'km';
}

/** Convert km to the slider display unit value. */
export function kmToSliderVal(km: number): number {
  const sys = getUnitSystem();
  if (sys === 'imperial') return Math.round(km * 0.621371);
  if (sys === 'aviation') return Math.round(km * 0.539957);
  return Math.round(km);
}

/** Convert slider display value back to km. */
export function sliderValToKm(val: number): number {
  const sys = getUnitSystem();
  if (sys === 'imperial') return val / 0.621371;
  if (sys === 'aviation') return val / 0.539957;
  return val;
}
