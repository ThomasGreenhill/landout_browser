import { Waypoint } from './types';
import { compositeTiles, CompositeResult } from './tile-compositer';
import { FieldDetection, buildRunwayRect, computeStripFromEndpoints } from './field-detector';

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
      statusEl.innerHTML = check.ok
        ? `<span style="color:#22c55e">Connected!</span>`
        : `<span style="color:#ef4444">${check.error}</span>`;
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
  const { metersPerPx } = composite;

  // Convert click lat/lon to pixel using proper Mercator projection
  const { x: cx, y: cy } = composite.latLonToPixel(centerLat, centerLon);

  const widthM = wp.rwwidth || Math.max(wp.rwlen * 0.04, 15);
  const corners = buildRunwayRect(cx, cy, wp.rwdir, wp.rwlen, wp.rwwidth, metersPerPx);
  const orientDeg = wp.rwdir > 180 ? wp.rwdir - 180 : wp.rwdir;

  return {
    boundaryPixels: corners,
    centerPixel: { x: cx, y: cy },
    lengthM: wp.rwlen,
    widthM: Math.round(widthM),
    orientationDeg: orientDeg,
    surface: 'unknown',
    obstructions: [],
    fieldPixelCount: 0,
    areaSqM: Math.round(wp.rwlen * widthM),
  };
}

// --- Detection from two endpoints (user-drawn) ---

export function detectFromEndpoints(
  _wp: Waypoint,
  composite: CompositeResult,
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  widthM = 30,
): FieldDetection {
  const strip = computeStripFromEndpoints(lat1, lon1, lat2, lon2, widthM);

  // Convert endpoints to pixels using proper Mercator
  const p1 = composite.latLonToPixel(lat1, lon1);
  const p2 = composite.latLonToPixel(lat2, lon2);
  const halfW = (widthM / 2) / composite.metersPerPx;

  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const perpX = len > 0 ? (-dy / len) * halfW : halfW;
  const perpY = len > 0 ? (dx / len) * halfW : 0;

  const corners = [
    { x: p1.x + perpX, y: p1.y + perpY },
    { x: p1.x - perpX, y: p1.y - perpY },
    { x: p2.x - perpX, y: p2.y - perpY },
    { x: p2.x + perpX, y: p2.y + perpY },
  ];

  const centerPx = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

  return {
    boundaryPixels: corners,
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
