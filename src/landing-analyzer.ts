import { Waypoint } from './types';
import { compositeTiles, CompositeResult } from './tile-compositer';
import { detectField, FieldDetection } from './field-detector';

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
    if (models.length === 0) {
      return { ok: false, error: 'No models installed. Run: ollama pull gemma3:4b', models };
    }
    if (!models.some((m: string) => m.startsWith(currentModel))) {
      return { ok: false, error: `Model "${currentModel}" not found. Available: ${models.join(', ')}`, models };
    }
    return { ok: true, models };
  } catch {
    return { ok: false, error: `Cannot reach Ollama at ${url}. Is it running? (ollama serve)` };
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
        <p style="font-size:13px;color:rgba(255,255,255,0.6);margin:0 0 4px">
          AI description is optional — field detection uses local computer vision.
        </p>
        <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 12px">
          Install: <a href="https://ollama.com" target="_blank" style="color:#3b82f6">ollama.com</a>
          &bull; Then run: <code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">ollama pull gemma3:4b</code>
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

// --- Detection output (CV-based) ---

export interface DetectionOutput {
  detection: FieldDetection;
  composite: CompositeResult;
}

const detectionCache = new Map<string, DetectionOutput>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/**
 * Instant field detection using client-side computer vision.
 * No AI needed — runs in ~100ms.
 */
export async function detectLandingSite(
  wp: Waypoint,
  onProgress: (message: string) => void,
): Promise<DetectionOutput> {
  const key = cacheKey(wp.lat, wp.lon);
  const cached = detectionCache.get(key);
  if (cached) return cached;

  onProgress('Fetching satellite tiles...');
  const composite = await compositeTiles(wp.lat, wp.lon, 17, 3);

  onProgress('Detecting field...');
  const detection = detectField(
    composite.canvas,
    composite.waypointPixel.x,
    composite.waypointPixel.y,
    composite.metersPerPx,
  );

  const output: DetectionOutput = { detection, composite };
  detectionCache.set(key, output);
  return output;
}

/**
 * Optional AI description via Ollama. Call after detectLandingSite.
 */
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
      model,
      stream: true,
      messages: [{
        role: 'user',
        content: `Describe this satellite image of a potential glider landing field. What is the surface condition? Any hazards for landing? Rate suitability 1-5 (1=unusable, 5=excellent). Be brief.${wp.rwdir ? ` Known runway: ${wp.rwdir}°/${wp.rwlen}m.` : ''}`,
        images: [base64],
      }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error (${response.status}): ${body.slice(0, 200)}`);
  }

  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) text += obj.message.content;
      } catch { /* skip */ }
    }
  }

  return text || 'No description available.';
}
