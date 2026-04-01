import L from 'leaflet';
import { Waypoint, WaypointStyle, HomeInfo } from './types';
import { FieldDetection, parseDescriptionHints } from './field-detector';
import { fmtElev, fmtShortDist, fmtDist } from './units';

const STYLE_CONFIG: Record<number, { css: string; label: string; size: number }> = {
  [WaypointStyle.GrassAirfield]: { css: 'marker-grass', label: 'Grass airfield', size: 20 },
  [WaypointStyle.Outlanding]: { css: 'marker-outlanding', label: 'Outlanding', size: 18 },
  [WaypointStyle.GlidingAirfield]: { css: 'marker-gliding', label: 'Gliding airfield', size: 22 },
  [WaypointStyle.PavedAirfield]: { css: 'marker-paved', label: 'Paved airfield', size: 22 },
  [WaypointStyle.Unknown]: { css: 'marker-unknown', label: 'Waypoint', size: 16 },
};

export function getStyleConfig(style: WaypointStyle) {
  return STYLE_CONFIG[style] ?? STYLE_CONFIG[WaypointStyle.Unknown];
}

// SVG icons for each waypoint type — aviation-style symbols
const MARKER_SVGS: Record<number, string> = {
  // Grass airfield: circle with green grass runway stripe
  [WaypointStyle.GrassAirfield]: `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#22c55e" stroke="#fff" stroke-width="1.5"/>
      <rect x="10" y="3" width="4" height="18" rx="1.5" fill="#fff" opacity="0.9"/>
      <line x1="8" y1="6" x2="16" y2="6" stroke="#fff" stroke-width="1.2" opacity="0.7"/>
      <line x1="8" y1="18" x2="16" y2="18" stroke="#fff" stroke-width="1.2" opacity="0.7"/>
    </svg>`,
  // Outlanding: orange diamond with field lines
  [WaypointStyle.Outlanding]: `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="16" height="16" rx="2" transform="rotate(45 12 12)" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/>
      <line x1="8" y1="12" x2="16" y2="12" stroke="#fff" stroke-width="1.5" opacity="0.85"/>
      <line x1="12" y1="8" x2="12" y2="16" stroke="#fff" stroke-width="1.5" opacity="0.85"/>
    </svg>`,
  // Gliding airfield: blue circle with glider silhouette
  [WaypointStyle.GlidingAirfield]: `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#3b82f6" stroke="#fff" stroke-width="1.5"/>
      <path d="M12 4 L12 20 M4 11 L20 11 Q12 14 12 14 Q12 14 4 11 Z" fill="#fff" opacity="0.9"/>
      <path d="M10 18 L14 18 L12 20 Z" fill="#fff" opacity="0.9"/>
    </svg>`,
  // Paved airfield: gray circle with runway + threshold marks
  [WaypointStyle.PavedAirfield]: `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#6b7280" stroke="#fff" stroke-width="1.5"/>
      <rect x="10" y="3" width="4" height="18" rx="0.5" fill="#fff" opacity="0.9"/>
      <line x1="10.5" y1="5" x2="13.5" y2="5" stroke="#6b7280" stroke-width="0.8"/>
      <line x1="10.5" y1="6.5" x2="13.5" y2="6.5" stroke="#6b7280" stroke-width="0.8"/>
      <line x1="10.5" y1="17.5" x2="13.5" y2="17.5" stroke="#6b7280" stroke-width="0.8"/>
      <line x1="10.5" y1="19" x2="13.5" y2="19" stroke="#6b7280" stroke-width="0.8"/>
      <line x1="11.8" y1="9" x2="11.8" y2="15" stroke="#6b7280" stroke-width="0.6" stroke-dasharray="1.5 1"/>
    </svg>`,
  // Unknown/waypoint: small purple pin
  [WaypointStyle.Unknown]: `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="8" fill="#a855f7" stroke="#fff" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="3" fill="#fff" opacity="0.8"/>
    </svg>`,
};

// Home marker: red circle with house icon
const HOME_SVG = `
  <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
    <circle cx="14" cy="14" r="13" fill="#ef4444" stroke="#fbbf24" stroke-width="2"/>
    <path d="M14 6 L6 14 L9 14 L9 21 L12 21 L12 17 L16 17 L16 21 L19 21 L19 14 L22 14 Z" fill="#fff" opacity="0.95"/>
  </svg>`;

export function createMarkerIcon(style: WaypointStyle, isHome = false): L.DivIcon {
  const size = isHome ? 28 : 24;
  const svg = isHome ? HOME_SVG : (MARKER_SVGS[style] ?? MARKER_SVGS[WaypointStyle.Unknown]);

  return L.divIcon({
    className: 'marker-svg-icon',
    html: svg,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

export function buildPopupHtml(wp: Waypoint, index: number, homeInfo?: HomeInfo): string {
  const config = getStyleConfig(wp.style);
  let html = `<div class="popup-name">${escapeHtml(wp.name)}`;
  if (wp.code) html += ` <span style="font-weight:normal;color:#888">(${escapeHtml(wp.code)})</span>`;
  html += '</div>';

  if (homeInfo) {
    html += `<div class="popup-distance">${fmtDist(homeInfo.distanceKm)} ${homeInfo.cardinalDir} of home (${homeInfo.bearingDeg.toFixed(0)}&deg;)</div>`;
  }

  html += `<div class="popup-detail">${config.label}`;
  html += ` &bull; ${fmtElev(wp.elev)} elev`;
  if (wp.country) html += ` &bull; ${escapeHtml(wp.country)}`;
  html += '</div>';

  if (wp.rwlen > 0) {
    html += `<div class="popup-detail">RWY: ${fmtShortDist(wp.rwlen)}`;
    if (wp.rwdir > 0) html += ` / ${wp.rwdir}&deg;`;
    html += '</div>';
  }

  if (wp.freq) {
    html += `<div class="popup-detail">Freq: ${escapeHtml(wp.freq)}</div>`;
  }

  if (wp.desc) {
    html += `<div class="popup-desc">${escapeHtml(wp.desc)}</div>`;
  }

  html += `<button class="popup-home-btn" data-home-index="${index}">Set as Home</button>`;
  return html;
}

export function buildTooltipText(wp: Waypoint, homeInfo?: HomeInfo): string {
  if (homeInfo) {
    return `${wp.name} — ${fmtDist(homeInfo.distanceKm)} ${homeInfo.cardinalDir}`;
  }
  return wp.name;
}

export function buildDetailPanelHtml(wp: Waypoint, index: number, homeInfo?: HomeInfo): string {
  const config = getStyleConfig(wp.style);

  let html = `<button class="detail-back-btn" id="detail-back">&larr; Back to overview</button>`;

  html += `<h2 class="detail-name">${escapeHtml(wp.name)}</h2>`;
  if (wp.code) html += `<div class="detail-code">${escapeHtml(wp.code)}</div>`;

  // Direction compass + distance (only when home is set)
  if (homeInfo) {
    const arrowRotation = homeInfo.bearingDeg + 180; // point back toward home
    html += `<div class="detail-home-section">`;
    html += `  <div class="detail-compass">`;
    html += `    <div class="compass-ring">`;
    html += `      <div class="compass-arrow" style="transform:rotate(${arrowRotation}deg)"></div>`;
    html += `      <div class="compass-label">N</div>`;
    html += `    </div>`;
    html += `  </div>`;
    html += `  <div class="detail-home-info">`;
    html += `    <div class="detail-distance">${fmtDist(homeInfo.distanceKm)}</div>`;
    html += `    <div class="detail-bearing">${homeInfo.cardinalDir} of home (${homeInfo.bearingDeg.toFixed(0)}&deg;)</div>`;
    html += `  </div>`;
    html += `</div>`;
  }

  // Info rows
  html += `<div class="detail-rows">`;
  html += `<div class="detail-row"><span class="detail-label">Type</span><span>${config.label}</span></div>`;
  html += `<div class="detail-row"><span class="detail-label">Elevation</span><span>${fmtElev(wp.elev)}</span></div>`;
  if (wp.country) {
    html += `<div class="detail-row"><span class="detail-label">Country</span><span>${escapeHtml(wp.country)}</span></div>`;
  }
  if (wp.rwlen > 0) {
    let rwy = fmtShortDist(wp.rwlen);
    if (wp.rwdir > 0) rwy += ` / ${wp.rwdir}&deg;`;
    html += `<div class="detail-row"><span class="detail-label">Runway</span><span>${rwy}</span></div>`;
  }
  if (wp.rwwidth > 0) {
    html += `<div class="detail-row"><span class="detail-label">RWY Width</span><span>${fmtShortDist(wp.rwwidth)}</span></div>`;
  }
  if (wp.freq) {
    html += `<div class="detail-row"><span class="detail-label">Frequency</span><span>${escapeHtml(wp.freq)}</span></div>`;
  }
  html += `<div class="detail-row"><span class="detail-label">Position</span><span>${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</span></div>`;
  html += `</div>`;

  if (wp.desc) {
    html += `<div class="detail-desc">${escapeHtml(wp.desc)}</div>`;
  }

  // Description hints for outlandings
  const hints = parseDescriptionHints(wp.desc);
  if (hints.headings || hints.lengthFt || hints.notes.length > 0) {
    html += `<div class="analysis-field" style="background:rgba(59,130,246,0.08);border-radius:8px;padding:8px;margin:8px 0">`;
    html += `<div class="analysis-field-header">Landing Hints from Description</div>`;
    if (hints.headings) html += `<div class="analysis-field-value">Headings: ${hints.headings[0]}&deg; / ${hints.headings[1]}&deg;</div>`;
    if (hints.lengthFt) html += `<div class="analysis-field-value">Length: ~${hints.lengthFt} ft (${hints.lengthM}m)</div>`;
    for (const note of hints.notes) html += `<div class="analysis-field-detail">${escapeHtml(note)}</div>`;
    html += `</div>`;
  }

  // Detection section
  const hasRunway = wp.rwdir > 0 && wp.rwlen > 0;
  const btnLabel = hasRunway ? 'Place Runway' : 'Draw Landing Strip';
  html += `<div class="detail-analysis-section">`;
  html += `<button class="detail-analyze-btn" id="detect-btn" data-wp-index="${index}">${btnLabel}</button>`;
  html += `<div id="analysis-result"></div>`;
  html += `</div>`;

  html += `<button class="popup-home-btn detail-home-btn" data-home-index="${index}">Set as Home</button>`;

  return html;
}

export function buildDetectionResultHtml(det: FieldDetection, waypointIndex: number): string {
  let html = '';

  // Dimensions
  const MIN_LENGTH_M = 305; // 1000 ft
  const tooShort = det.lengthM > 0 && det.lengthM < MIN_LENGTH_M;
  html += `<div class="analysis-field">`;
  html += `<div class="analysis-field-header">Detected Landing Strip</div>`;
  html += `<div class="analysis-field-value">${fmtShortDist(det.lengthM)} &times; <span id="strip-width-display">${fmtShortDist(det.widthM)}</span></div>`;
  html += `<div class="analysis-field-detail">Orientation: ${det.orientationDeg}&deg; &bull; Area: ${Math.round(det.areaSqM / 10000 * 10) / 10} ha</div>`;
  if (det.endpoint1 && det.endpoint2) {
    html += `<div class="analysis-field-detail" style="display:flex;align-items:center;gap:6px;margin-top:4px">Width: <input type="range" id="strip-width-input" min="5" max="100" value="${det.widthM}" style="flex:1;accent-color:#f59e0b"> <span style="min-width:35px">${det.widthM}m</span></div>`;
  }
  if (tooShort) {
    html += `<div class="analysis-error" style="margin-top:4px">&#9888; Below minimum 1000 ft (${fmtShortDist(MIN_LENGTH_M)}) landing length</div>`;
  }
  html += `</div>`;

  // Surface
  html += `<div class="analysis-field">`;
  html += `<div class="analysis-field-header">Surface</div>`;
  html += `<div class="analysis-field-value">${formatSurface(det.surface)}</div>`;
  html += `</div>`;

  // Terrain profile (populated async after detection)
  html += `<div class="analysis-field">`;
  html += `<div class="analysis-field-header">Terrain Profile</div>`;
  html += `<div id="terrain-profile"><span style="color:rgba(255,255,255,0.4);font-size:11px">Loading terrain...</span></div>`;
  html += `</div>`;

  // Obstructions
  if (det.obstructions.length > 0) {
    html += `<div class="analysis-field">`;
    html += `<div class="analysis-field-header">Perimeter Obstructions</div>`;
    for (const obs of det.obstructions) {
      html += `<div class="analysis-obstruction">`;
      html += `<span class="obstruction-type">${formatSurface(obs.type)}</span>`;
      html += `<span class="obstruction-detail">${obs.direction}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // AI description button (optional)
  html += `<div style="margin-top:12px">`;
  html += `<button class="detail-analyze-btn" id="ai-describe-btn" data-wp-index="${waypointIndex}" style="background:#6b7280;font-size:12px;padding:6px 12px">Get AI Description (Ollama)</button>`;
  html += `<div id="ai-description"></div>`;
  html += `</div>`;

  html += `<div class="analysis-key-link"><a href="#" id="change-ollama-settings">Ollama Settings</a></div>`;
  return html;
}

function formatSurface(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
