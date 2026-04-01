import { Waypoint } from './types';
import { AnalysisResult } from './analysis-types';
import { compositeTiles } from './tile-compositer';
import { getStyleConfig } from './marker-factory';

const OLLAMA_URL_KEY = 'landout-ollama-url';
const OLLAMA_MODEL_KEY = 'landout-ollama-model';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2-vision';


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

/**
 * Check if Ollama is reachable and the model is available.
 */
export async function checkOllamaConnection(): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const url = getOllamaUrl();
  try {
    const resp = await fetch(`${url}/api/tags`);
    if (!resp.ok) return { ok: false, error: `Ollama returned ${resp.status}` };
    const data = await resp.json();
    const models = (data.models || []).map((m: { name: string }) => m.name);
    const currentModel = getOllamaModel();
    if (models.length === 0) {
      return { ok: false, error: 'No models installed. Run: ollama pull llama3.2-vision', models };
    }
    if (!models.some((m: string) => m.startsWith(currentModel))) {
      return { ok: false, error: `Model "${currentModel}" not found. Available: ${models.join(', ')}`, models };
    }
    return { ok: true, models };
  } catch {
    return { ok: false, error: `Cannot reach Ollama at ${url}. Is it running? (ollama serve)` };
  }
}

/**
 * Show a modal for Ollama connection settings.
 * Returns true if user saved, false if cancelled.
 */
export function promptForSettings(): Promise<boolean> {
  return new Promise((resolve) => {
    const currentUrl = getOllamaUrl();
    const currentModel = getOllamaModel();

    const modal = document.createElement('div');
    modal.className = 'api-key-modal';
    modal.innerHTML = `
      <div class="api-key-modal-content">
        <h3 style="margin:0 0 8px">Ollama Settings</h3>
        <p style="font-size:13px;color:rgba(255,255,255,0.6);margin:0 0 4px">
          Analysis runs locally via Ollama — no API key needed.
        </p>
        <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 12px">
          Install: <a href="https://ollama.com" target="_blank" style="color:#3b82f6">ollama.com</a>
          &bull; Then run: <code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">ollama pull llama3.2-vision</code>
        </p>
        <label style="font-size:12px;color:rgba(255,255,255,0.5);display:block;margin-bottom:2px">Ollama URL</label>
        <input type="text" id="ollama-url-input" value="${currentUrl}" autocomplete="off" />
        <label style="font-size:12px;color:rgba(255,255,255,0.5);display:block;margin-bottom:2px">Model</label>
        <input type="text" id="ollama-model-input" value="${currentModel}" autocomplete="off" />
        <div id="ollama-status" style="font-size:12px;margin:8px 0;min-height:18px"></div>
        <div class="api-key-modal-actions">
          <button class="detail-back-btn" id="ollama-cancel">Cancel</button>
          <button class="detail-back-btn" id="ollama-test" style="border-color:#3b82f6;color:#3b82f6">Test</button>
          <button class="detail-analyze-btn" id="ollama-save" style="width:auto;padding:8px 20px">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const urlInput = document.getElementById('ollama-url-input') as HTMLInputElement;
    const modelInput = document.getElementById('ollama-model-input') as HTMLInputElement;
    const statusEl = document.getElementById('ollama-status')!;

    function cleanup(saved: boolean) {
      modal.remove();
      resolve(saved);
    }

    document.getElementById('ollama-cancel')!.addEventListener('click', () => cleanup(false));

    document.getElementById('ollama-test')!.addEventListener('click', async () => {
      setOllamaSettings(urlInput.value.trim(), modelInput.value.trim());
      statusEl.innerHTML = '<span style="color:#f59e0b">Testing connection...</span>';
      const check = await checkOllamaConnection();
      if (check.ok) {
        statusEl.innerHTML = '<span style="color:#22c55e">Connected! Model available.</span>';
        if (check.models) {
          statusEl.innerHTML += `<br><span style="color:rgba(255,255,255,0.4);font-size:11px">Models: ${check.models.join(', ')}</span>`;
        }
      } else {
        statusEl.innerHTML = `<span style="color:#ef4444">${check.error}</span>`;
      }
    });

    document.getElementById('ollama-save')!.addEventListener('click', () => {
      const url = urlInput.value.trim();
      const model = modelInput.value.trim();
      if (url && model) {
        setOllamaSettings(url, model);
        cleanup(true);
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) cleanup(false);
    });
  });
}

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function buildPrompt(
  wp: Waypoint,
  metersPerPx: number,
  totalWidthM: number,
): string {
  const styleLabel = getStyleConfig(wp.style).label;

  const imgSize = 5 * 256;

  return `Analyze this satellite image of a glider landing field. Red crosshair = waypoint. Scale: ${metersPerPx.toFixed(1)} m/pixel, image is ${imgSize}px wide (~${Math.round(totalWidthM)}m). North is up. Image center pixel is (${imgSize / 2},${imgSize / 2}).

Waypoint: "${wp.name}" (${styleLabel}), ${Math.round(wp.elev)}m elev.${wp.rwdir ? ` RWY ${wp.rwdir}°/${wp.rwlen}m.` : ''}

Briefly describe: field dimensions, surface type, obstructions, best approach, and rate 1-5.

Then provide this JSON (replace values with your analysis):
\`\`\`json
{"landableArea":{"lengthM":450,"widthM":80,"orientationDeg":270,"usableLengthM":400,"centerPixel":{"x":680,"y":610}},"surface":{"primary":"grass","confidence":"medium","notes":"mowed"},"obstructions":[{"type":"trees","location":"east","severity":"moderate","description":"tree line"}],"approach":{"bestDirection":"from west","hazards":["trees east"],"notes":"clear west"},"suitability":{"rating":4,"summary":"Good field."}}
\`\`\``;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  // Try direct parse
  try { return JSON.parse(text); } catch { /* continue */ }

  // Try extracting JSON from code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }

  // Try extracting the outermost { ... } block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* continue */ }
  }

  return null;
}

function parseAnalysisResponse(text: string): AnalysisResult {
  const parsed = tryParseJson(text);

  if (parsed) {
    const result = parsed as unknown as AnalysisResult;
    result.rawResponse = text;
    if (!result.landableArea) {
      result.landableArea = { lengthM: 0, widthM: 0, orientationDeg: 0, usableLengthM: 0 };
    }
    if (!result.surface) {
      result.surface = { primary: 'unknown', confidence: 'low', notes: '' };
    }
    if (!result.obstructions) {
      result.obstructions = [];
    }
    if (!result.approach) {
      result.approach = { bestDirection: 'Unknown', hazards: [], notes: '' };
    }
    if (!result.suitability) {
      result.suitability = { rating: 3, summary: 'Analysis incomplete' };
    }
    return result;
  }

  // JSON parsing failed — return a raw-text result so the user still sees the analysis
  return {
    landableArea: { lengthM: 0, widthM: 0, orientationDeg: 0, usableLengthM: 0 },
    surface: { primary: 'unknown', confidence: 'low', notes: '' },
    obstructions: [],
    approach: { bestDirection: '', hazards: [], notes: '' },
    suitability: { rating: 0 as AnalysisResult['suitability']['rating'], summary: '' },
    rawResponse: text,
  };
}

export interface AnalysisOutput {
  result: AnalysisResult;
  pixelToLatLon: (px: number, py: number) => { lat: number; lon: number };
}

const outputCache = new Map<string, AnalysisOutput>();

export async function analyzeLandingSite(
  wp: Waypoint,
  onProgress: (message: string) => void,
): Promise<AnalysisOutput> {
  const key = cacheKey(wp.lat, wp.lon);
  const cached = outputCache.get(key);
  if (cached) return cached;

  // Check Ollama is reachable
  onProgress('Connecting to Ollama...');
  const check = await checkOllamaConnection();
  if (!check.ok) {
    throw new Error(check.error || 'Cannot connect to Ollama');
  }

  onProgress('Fetching satellite tiles...');
  const zoom = 17;
  const composite = await compositeTiles(wp.lat, wp.lon, zoom);

  // Strip the data URL prefix to get raw base64
  const base64 = composite.dataUrl.replace(/^data:image\/jpeg;base64,/, '');

  const ollamaUrl = getOllamaUrl();
  const model = getOllamaModel();

  onProgress(`Analyzing with ${model}...`);

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: buildPrompt(wp, composite.metersPerPx, composite.totalWidthM),
          images: [base64],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.message?.content;
  if (!text) {
    throw new Error('No response content from Ollama');
  }

  const result = parseAnalysisResponse(text);
  const output: AnalysisOutput = {
    result,
    pixelToLatLon: composite.pixelToLatLon,
  };
  outputCache.set(key, output);
  return output;
}
