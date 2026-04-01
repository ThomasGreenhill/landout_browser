import L from 'leaflet';
import { Waypoint, WaypointStyle, HomeInfo } from './types';

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

export function createMarkerIcon(style: WaypointStyle, isHome = false): L.DivIcon {
  const config = getStyleConfig(style);
  const size = isHome ? 28 : config.size;
  const css = isHome ? 'marker-icon marker-home' : `marker-icon ${config.css}`;
  const inner = isHome ? '&#8962;' : '';

  return L.divIcon({
    className: '',
    html: `<div class="${css}" style="width:${size}px;height:${size}px">${inner}</div>`,
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
    html += `<div class="popup-distance">${homeInfo.distanceKm.toFixed(1)} km ${homeInfo.cardinalDir} of home (${homeInfo.bearingDeg.toFixed(0)}&deg;)</div>`;
  }

  html += `<div class="popup-detail">${config.label}`;
  html += ` &bull; ${Math.round(wp.elev)}m elev`;
  if (wp.country) html += ` &bull; ${escapeHtml(wp.country)}`;
  html += '</div>';

  if (wp.rwlen > 0) {
    html += `<div class="popup-detail">RWY: ${Math.round(wp.rwlen)}m`;
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
    return `${wp.name} — ${homeInfo.distanceKm.toFixed(1)} km ${homeInfo.cardinalDir}`;
  }
  return wp.name;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
