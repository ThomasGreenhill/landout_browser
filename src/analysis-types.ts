export type SurfaceType =
  | 'grass'
  | 'crop'
  | 'stubble'
  | 'bare_earth'
  | 'paved'
  | 'gravel'
  | 'mixed'
  | 'unknown';

export interface Obstruction {
  type: 'power_line' | 'trees' | 'fence' | 'building' | 'road' | 'water' | 'terrain' | 'other';
  location: string;
  severity: 'minor' | 'moderate' | 'critical';
  description: string;
}

export interface AnalysisResult {
  landableArea: {
    lengthM: number;
    widthM: number;
    orientationDeg: number;
    usableLengthM: number;
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
