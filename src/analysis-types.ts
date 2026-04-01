export type SurfaceType =
  | 'grass'
  | 'crop'
  | 'stubble'
  | 'bare_earth'
  | 'paved'
  | 'gravel'
  | 'mixed'
  | 'unknown';

export interface PixelPoint {
  x: number;
  y: number;
}

export interface Obstruction {
  type: 'power_line' | 'trees' | 'fence' | 'building' | 'road' | 'water' | 'terrain' | 'other';
  location: string;
  severity: 'minor' | 'moderate' | 'critical';
  description: string;
  /** Approximate pixel position in the 1280x1280 composite image */
  pixelPos?: PixelPoint;
}

export interface AnalysisResult {
  landableArea: {
    lengthM: number;
    widthM: number;
    orientationDeg: number;
    usableLengthM: number;
    /** Center of the landing field in pixel coordinates (1280x1280 image) */
    centerPixel?: PixelPoint;
    /** Four corners of the landable area in pixel coordinates (1280x1280 image) */
    corners?: PixelPoint[];
  };
  surface: {
    primary: SurfaceType;
    confidence: 'high' | 'medium' | 'low';
    notes: string;
  };
  obstructions: Obstruction[];
  approach: {
    bestDirection: string;
    hazards: string[];
    notes: string;
  };
  suitability: {
    rating: 1 | 2 | 3 | 4 | 5;
    summary: string;
  };
  rawResponse: string;
}

export type AnalysisState =
  | { status: 'idle' }
  | { status: 'loading'; message: string }
  | { status: 'success'; result: AnalysisResult }
  | { status: 'error'; error: string };
