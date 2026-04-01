export enum WaypointStyle {
  Unknown = 1,
  GrassAirfield = 2,
  Outlanding = 3,
  GlidingAirfield = 4,
  PavedAirfield = 5,
}

export interface Waypoint {
  name: string;
  code: string;
  country: string;
  lat: number;
  lon: number;
  elev: number;
  style: WaypointStyle;
  rwdir: number;
  rwlen: number;
  rwwidth: number;
  freq: string;
  desc: string;
}

export interface HomeInfo {
  distanceKm: number;
  bearingDeg: number;
  cardinalDir: string;
}
