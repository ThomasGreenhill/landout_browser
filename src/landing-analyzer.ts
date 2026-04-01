import { Waypoint } from './types';
import { compositeTiles, CompositeResult } from './tile-compositer';
import { FieldDetection, computeStripFromEndpoints } from './field-detector';

// --- Ollama settings ---

const OLLAMA_URL_KEY = 'landout-ollama-url';
const OLLAMA_MODEL_KEY = 'landout-ollama-model';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma3:4b';

export function getOllamaUrl(): string {
  return localStorage.getItem(OLLAMA_URL_KEY) || DEFAULT_OLLAMA_URL;
}

export function getOllamaModel(): string {
  return localStorage.getItem(OLLAMA_MODEL_KEY) || DEFAULT_OLLAMA_MODEL;
}

export function setOllamaSettings(url: string, model: string): void {
  localStorage.setItem(OLLAMA_URL_KEY, url);
  localStorage.setItem(OLLAMA_MODEL_KEY, model);
}

export async function checkOllamaConnection(): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const url = getOllamaUrl();
  try {
    const resp = await fetch(`${url}/api/tags`);
    if (!resp.ok) return { ok: false, error: `Ollama returned ${resp.status}` };
    const data = await resp.json();
    const models = (data.models || []).map((m: { name: string }) => m.name);
    const currentModel = getOllamaModel();
    if (models.length === 0) return { ok: false, error: 'No models installed.', models };
    if (!models.some((m: string) => m.startsWith(currentModel)))
      return { ok: false, error: `Model "${currentModel}" not found. Available: ${models.join(', ')}`, models };
    return { ok: true, models };
  } catch {
    return { ok: false, error: `Cannot reach Ollama at ${url}. Is it running?` };
  }
}

export function promptForSettings(): Promise<boolean> {
  return new Promise((resolve) => {
    const currentUrl = getOllamaUrl();
    const currentModel = getOllamaModel();
    const modal = document.createElement('div');
    modal.className = 'api-key-modal';
    modal.innerHTML = `
      <div class="api-key-modal-content">
        <h3 style="margin:0 0 8px">Ollama Settings</h3>
        <p style="font-size:13px;color:rgba(255,255,255,0.6);margin:0 0 12px">Optional AI description via Ollama.</p>
        <label style="font-size:12px;color:rgba(255,255,255,0.5)">URL</label>
        <input type="text" id="ollama-url-input" value="${currentUrl}" autocomplete="off" />
        <label style="font-size:12px;color:rgba(255,255,255,0.5)">Model</label>
        <input type="text" id="ollama-model-input" value="${currentModel}" autocomplete="off" />
        <div id="ollama-status" style="font-size:12px;margin:8px 0;min-height:18px"></div>
        <div class="api-key-modal-actions">
          <button class="detail-back-btn" id="ollama-cancel">Cancel</button>
          <button class="detail-back-btn" id="ollama-test" style="border-color:#3b82f6;color:#3b82f6">Test</button>
          <button class="detail-analyze-btn" id="ollama-save" style="width:auto;padding:8px 20px">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const urlInput = document.getElementById('ollama-url-input') as HTMLInputElement;
    const modelInput = document.getElementById('ollama-model-input') as HTMLInputElement;
    const statusEl = document.getElementById('ollama-status')!;
    function cleanup(saved: boolean) { modal.remove(); resolve(saved); }
    document.getElementById('ollama-cancel')!.addEventListener('click', () => cleanup(false));
    document.getElementById('ollama-test')!.addEventListener('click', async () => {
      setOllamaSettings(urlInput.value.trim(), modelInput.value.trim());
      statusEl.innerHTML = '<span style="color:#f59e0b">Testing...</span>';
      const check = await checkOllamaConnection();
      if (check.ok) {
        statusEl.innerHTML = '<span style="color:#22c55e">Connected!</span>';
      } else {
        statusEl.textContent = '';
        const errSpan = document.createElement('span');
        errSpan.style.color = '#ef4444';
        errSpan.textContent = check.error || 'Unknown error';
        statusEl.appendChild(errSpan);
      }
    });
    document.getElementById('ollama-save')!.addEventListener('click', () => {
      const url = urlInput.value.trim(), model = modelInput.value.trim();
      if (url && model) { setOllamaSettings(url, model); cleanup(true); }
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(false); });
  });
}

// --- Detection output ---

export interface DetectionOutput {
  detection: FieldDetection;
  composite: CompositeResult;
}

export type { CompositeResult };

// --- Saved strips persistence ---

const SAVED_STRIPS_KEY = 'landout-saved-strips';

interface SavedStrip {
  lat1: number; lon1: number;
  lat2: number; lon2: number;
  widthM: number;
}

function savedStripKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function getSavedStrip(lat: number, lon: number): SavedStrip | null {
  try {
    const all = JSON.parse(localStorage.getItem(SAVED_STRIPS_KEY) || '{}');
    return all[savedStripKey(lat, lon)] || null;
  } catch { return null; }
}

export function saveStrip(lat: number, lon: number, strip: SavedStrip): void {
  try {
    const all = JSON.parse(localStorage.getItem(SAVED_STRIPS_KEY) || '{}');
    all[savedStripKey(lat, lon)] = strip;
    localStorage.setItem(SAVED_STRIPS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

// --- Tile fetching ---

export async function fetchTilesForWaypoint(
  wp: Waypoint,
  onProgress: (message: string) => void,
): Promise<CompositeResult> {
  onProgress('Fetching satellite tiles...');
  return compositeTiles(wp.lat, wp.lon, 17, 3);
}

// --- Detection from known runway data (center click) ---

export function detectFromRunwayData(
  wp: Waypoint,
  composite: CompositeResult,
  centerLat: number,
  centerLon: number,
): FieldDetection {
  const widthM = wp.rwwidth || Math.max(wp.rwlen * 0.04, 15);
  const orientDeg = wp.rwdir > 180 ? wp.rwdir - 180 : wp.rwdir;

  // Build corners in lat/lon space using geodesic offsets, then convert to pixels
  const halfLen = wp.rwlen / 2;
  const halfWid = widthM / 2;
  const e1 = offsetLatLon(centerLat, centerLon, halfLen, wp.rwdir);
  const e2 = offsetLatLon(centerLat, centerLon, halfLen, (wp.rwdir + 180) % 360);
  const c1 = offsetLatLon(e1[0], e1[1], halfWid, (wp.rwdir + 90) % 360);
  const c2 = offsetLatLon(e1[0], e1[1], halfWid, (wp.rwdir + 270) % 360);
  const c3 = offsetLatLon(e2[0], e2[1], halfWid, (wp.rwdir + 270) % 360);
  const c4 = offsetLatLon(e2[0], e2[1], halfWid, (wp.rwdir + 90) % 360);

  const cornerLatLons = [c1, c2, c3, c4];
  const cornerPixels = cornerLatLons.map(c => composite.latLonToPixel(c[0], c[1]));
  const centerPx = composite.latLonToPixel(centerLat, centerLon);

  return {
    boundaryPixels: cornerPixels,
    boundaryLatLons: cornerLatLons,
    centerPixel: centerPx,
    endpoint1: { lat: e1[0], lon: e1[1] },
    endpoint2: { lat: e2[0], lon: e2[1] },
    lengthM: wp.rwlen,
    widthM: Math.round(widthM),
    orientationDeg: orientDeg,
    surface: 'unknown',
    obstructions: [],
    fieldPixelCount: 0,
    areaSqM: Math.round(wp.rwlen * widthM),
  };
}

function offsetLatLon(lat: number, lon: number, distM: number, bearingDeg: number): [number, number] {
  const R = 6371000;
  const brng = (bearingDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const d = distM / R;
  const lat2 = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brng));
  const lon2 = lonR + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// --- Width auto-detection ---

/**
 * Detect strip width by scanning perpendicular cross-sections along the strip.
 * At each sample point, walks outward from the centerline in both perpendicular
 * directions until it finds a color edge (sharp RGB change from the strip surface).
 * Returns the median detected width across all samples.
 */
function detectStripWidth(
  canvas: HTMLCanvasElement,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  numSamples = 7,
): number {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;

  // Strip direction in pixels
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 5) return 0;

  // Perpendicular direction (unit vector)
  const perpX = -dy / len, perpY = dx / len;

  const edgeThreshold = 30; // RGB distance for edge detection
  const maxScanPx = 150; // max scan distance in pixels per side
  const step = 2;

  const widths: number[] = [];

  for (let i = 0; i < numSamples; i++) {
    // Sample point along the strip (skip 10% at each end to avoid runway markings)
    const t = 0.1 + (i / (numSamples - 1)) * 0.8;
    const cx = Math.round(p1.x + dx * t);
    const cy = Math.round(p1.y + dy * t);
    if (cx < 3 || cy < 3 || cx >= width - 3 || cy >= height - 3) continue;

    // Sample the centerline color
    const ci = (cy * width + cx) * 4;
    let seedR = data[ci], seedG = data[ci + 1], seedB = data[ci + 2];

    // Average a small patch for noise reduction
    let tr = 0, tg = 0, tb = 0, tc = 0;
    for (let ky = -2; ky <= 2; ky++) {
      for (let kx = -2; kx <= 2; kx++) {
        const pi = ((cy + ky) * width + (cx + kx)) * 4;
        if (pi >= 0 && pi < data.length - 3) { tr += data[pi]; tg += data[pi+1]; tb += data[pi+2]; tc++; }
      }
    }
    if (tc > 0) { seedR = tr / tc; seedG = tg / tc; seedB = tb / tc; }

    // Scan left (positive perpendicular)
    let leftDist = 0;
    let prevR = seedR, prevG = seedG, prevB = seedB;
    for (let d = step; d < maxScanPx; d += step) {
      const sx = Math.round(cx + perpX * d), sy = Math.round(cy + perpY * d);
      if (sx < 1 || sy < 1 || sx >= width - 1 || sy >= height - 1) break;
      const si = (sy * width + sx) * 4;
      const r = data[si], g = data[si + 1], b = data[si + 2];
      // Check for edge: sharp jump from previous sample
      const jumpFromPrev = Math.sqrt((r - prevR) ** 2 + (g - prevG) ** 2 + (b - prevB) ** 2);
      // Also check drift from seed
      const jumpFromSeed = Math.sqrt((r - seedR) ** 2 + (g - seedG) ** 2 + (b - seedB) ** 2);
      if (jumpFromPrev > edgeThreshold || jumpFromSeed > edgeThreshold * 1.5) {
        leftDist = d;
        break;
      }
      prevR = r; prevG = g; prevB = b;
      leftDist = d;
    }

    // Scan right (negative perpendicular)
    let rightDist = 0;
    prevR = seedR; prevG = seedG; prevB = seedB;
    for (let d = step; d < maxScanPx; d += step) {
      const sx = Math.round(cx - perpX * d), sy = Math.round(cy - perpY * d);
      if (sx < 1 || sy < 1 || sx >= width - 1 || sy >= height - 1) break;
      const si = (sy * width + sx) * 4;
      const r = data[si], g = data[si + 1], b = data[si + 2];
      const jumpFromPrev = Math.sqrt((r - prevR) ** 2 + (g - prevG) ** 2 + (b - prevB) ** 2);
      const jumpFromSeed = Math.sqrt((r - seedR) ** 2 + (g - seedG) ** 2 + (b - seedB) ** 2);
      if (jumpFromPrev > edgeThreshold || jumpFromSeed > edgeThreshold * 1.5) {
        rightDist = d;
        break;
      }
      prevR = r; prevG = g; prevB = b;
      rightDist = d;
    }

    if (leftDist > 2 && rightDist > 2) {
      widths.push(leftDist + rightDist);
    }
  }

  if (widths.length === 0) return 0;

  // Return median width (robust against outliers from taxiways, aprons etc)
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

// --- Detection from two endpoints (user-drawn) ---

export function detectFromEndpoints(
  _wp: Waypoint,
  composite: CompositeResult,
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  widthOverrideM?: number,
): FieldDetection {
  const strip = computeStripFromEndpoints(lat1, lon1, lat2, lon2, 0);

  // Auto-detect width from satellite image pixels
  const p1px = composite.latLonToPixel(lat1, lon1);
  const p2px = composite.latLonToPixel(lat2, lon2);
  const detectedWidthPx = detectStripWidth(composite.canvas, p1px, p2px);
  const detectedWidthM = Math.round(detectedWidthPx * composite.metersPerPx);

  // Use override if provided, otherwise auto-detected, with minimum of 5m
  const widthM = widthOverrideM ?? Math.max(detectedWidthM, 5);

  // Build corners in lat/lon space
  const halfWid = widthM / 2;
  const bearing = strip.orientationDeg;
  const c1 = offsetLatLon(lat1, lon1, halfWid, (bearing + 90) % 360);
  const c2 = offsetLatLon(lat1, lon1, halfWid, (bearing + 270) % 360);
  const c3 = offsetLatLon(lat2, lon2, halfWid, (bearing + 270) % 360);
  const c4 = offsetLatLon(lat2, lon2, halfWid, (bearing + 90) % 360);
  const cornerLatLons: Array<[number, number]> = [c1, c2, c3, c4];

  const cornerPixels = cornerLatLons.map(c => composite.latLonToPixel(c[0], c[1]));
  const centerPx = { x: (p1px.x + p2px.x) / 2, y: (p1px.y + p2px.y) / 2 };

  return {
    boundaryPixels: cornerPixels,
    boundaryLatLons: cornerLatLons,
    centerPixel: centerPx,
    endpoint1: { lat: lat1, lon: lon1 },
    endpoint2: { lat: lat2, lon: lon2 },
    lengthM: strip.lengthM,
    widthM,
    orientationDeg: strip.orientationDeg,
    surface: 'unknown',
    obstructions: [],
    fieldPixelCount: 0,
    areaSqM: Math.round(strip.lengthM * widthM),
  };
}

// --- Optional AI description ---

export async function getAiDescription(
  wp: Waypoint,
  composite: CompositeResult,
  onProgress: (message: string) => void,
): Promise<string> {
  const check = await checkOllamaConnection();
  if (!check.ok) throw new Error(check.error || 'Cannot connect to Ollama');
  const base64 = composite.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  const ollamaUrl = getOllamaUrl();
  const model = getOllamaModel();
  onProgress(`Getting AI description (${model})...`);

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: true,
      messages: [{
        role: 'user',
        content: `Describe this satellite image of a potential glider landing field. What is the surface condition? Any hazards? Rate suitability 1-5. Be brief.${wp.rwdir ? ` Known runway: ${wp.rwdir}°/${wp.rwlen}m.` : ''}`,
        images: [base64],
      }],
    }),
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (!line.trim()) continue;
      try { const obj = JSON.parse(line); if (obj.message?.content) text += obj.message.content; } catch { /* skip */ }
    }
  }
  return text || 'No description available.';
}
