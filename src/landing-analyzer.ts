import Anthropic from '@anthropic-ai/sdk';
import { Waypoint } from './types';
import { AnalysisResult } from './analysis-types';
import { compositeTiles } from './tile-compositer';
import { getStyleConfig } from './marker-factory';

const API_KEY_STORAGE_KEY = 'landout-anthropic-api-key';
const analysisCache = new Map<string, AnalysisResult>();

export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

/**
 * Show a modal dialog prompting the user for their Anthropic API key.
 * Returns the key or null if the user cancelled.
 */
export function promptForApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'api-key-modal';
    modal.innerHTML = `
      <div class="api-key-modal-content">
        <h3 style="margin:0 0 8px">Anthropic API Key</h3>
        <p style="font-size:13px;color:rgba(255,255,255,0.6);margin:0 0 12px">
          Enter your Anthropic API key to enable AI-powered landing site analysis.
          The key is stored locally in your browser and sent directly to Anthropic's API.
        </p>
        <input type="password" id="api-key-input" placeholder="sk-ant-..." autocomplete="off" />
        <div class="api-key-modal-actions">
          <button class="detail-back-btn" id="api-key-cancel">Cancel</button>
          <button class="detail-analyze-btn" id="api-key-save" style="width:auto;padding:8px 20px">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = document.getElementById('api-key-input') as HTMLInputElement;
    input.focus();

    function cleanup(key: string | null) {
      modal.remove();
      resolve(key);
    }

    document.getElementById('api-key-cancel')!.addEventListener('click', () => cleanup(null));
    document.getElementById('api-key-save')!.addEventListener('click', () => {
      const key = input.value.trim();
      if (key) {
        setApiKey(key);
        cleanup(key);
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const key = input.value.trim();
        if (key) {
          setApiKey(key);
          cleanup(key);
        }
      } else if (e.key === 'Escape') {
        cleanup(null);
      }
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cleanup(null);
    });
  });
}

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function buildSystemPrompt(
  wp: Waypoint,
  metersPerPx: number,
  totalWidthM: number,
  zoom: number,
): string {
  const styleLabel = getStyleConfig(wp.style).label;
  const tileWidthM = Math.round(256 * metersPerPx);

  return `You are an expert glider pilot and aerial imagery analyst. You are examining a satellite image of a potential emergency landing site (landout field) for gliders. The image is centered on a waypoint marked with a red crosshair.

Image properties:
- Zoom level: ${zoom}
- Scale: approximately ${metersPerPx.toFixed(2)} meters per pixel
- Total image coverage: approximately ${Math.round(totalWidthM)}m x ${Math.round(totalWidthM)}m
- Each grid tile is 256x256 pixels = approximately ${tileWidthM}m x ${tileWidthM}m
- Center coordinates: ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}
- Elevation: ${Math.round(wp.elev)}m MSL

Waypoint metadata from the cup file:
- Name: ${wp.name}
- Type: ${styleLabel}
- Runway direction: ${wp.rwdir}° (0 = not specified)
- Runway length: ${wp.rwlen}m (0 = not specified)
- Runway width: ${wp.rwwidth}m (0 = not specified)
- Description: ${wp.desc || 'none'}

Analyze this image for suitability as a glider landing site. Respond ONLY with a JSON object matching this exact schema (no markdown, no code fences, no extra text):

{
  "landableArea": {
    "lengthM": <number: estimated usable length in meters>,
    "widthM": <number: estimated usable width in meters>,
    "orientationDeg": <number: estimated orientation 0-359>,
    "usableLengthM": <number: usable length after accounting for obstacles>
  },
  "surface": {
    "primary": <string: one of "grass", "crop", "stubble", "bare_earth", "paved", "gravel", "mixed", "unknown">,
    "confidence": <string: "high", "medium", or "low">,
    "notes": <string: details about surface condition>
  },
  "obstructions": [
    {
      "type": <string: one of "power_line", "trees", "fence", "building", "road", "water", "terrain", "other">,
      "location": <string: e.g. "northern boundary", "200m east of center">,
      "severity": <string: "minor", "moderate", or "critical">,
      "description": <string: brief description>
    }
  ],
  "approach": {
    "bestDirection": <string: e.g. "from the SW on heading 045">,
    "hazards": [<string>, ...],
    "notes": <string: additional approach/departure considerations>
  },
  "suitability": {
    "rating": <number: 1-5, where 1=unusable, 2=emergency only, 3=marginal, 4=good, 5=excellent>,
    "summary": <string: one sentence overall assessment>
  }
}`;
}

function parseAnalysisResponse(text: string): AnalysisResult {
  let parsed: Record<string, unknown>;

  // Try direct parse
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try extracting JSON between first { and last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try stripping code fences
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenceMatch) {
          parsed = JSON.parse(fenceMatch[1]);
        } else {
          throw new Error('Could not parse analysis response as JSON');
        }
      }
    } else {
      throw new Error('No JSON found in analysis response');
    }
  }

  // Validate and cast with defaults
  const result = parsed as unknown as AnalysisResult;
  result.rawResponse = text;

  // Ensure required fields have defaults
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

export async function analyzeLandingSite(
  wp: Waypoint,
  apiKey: string,
  onProgress: (message: string) => void,
): Promise<AnalysisResult> {
  const key = cacheKey(wp.lat, wp.lon);
  const cached = analysisCache.get(key);
  if (cached) return cached;

  onProgress('Fetching satellite tiles...');
  const zoom = 17;
  const { dataUrl, metersPerPx, totalWidthM } = await compositeTiles(wp.lat, wp.lon, zoom);

  // Strip the data URL prefix to get raw base64
  const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

  onProgress('Analyzing with Claude...');
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: buildSystemPrompt(wp, metersPerPx, totalWidthM, zoom),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64,
            },
          },
          {
            type: 'text',
            text: 'Analyze this landing site satellite image.',
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const result = parseAnalysisResponse(textBlock.text);
  analysisCache.set(key, result);
  return result;
}
