import L from 'leaflet';
import { Waypoint, WaypointStyle, HomeInfo } from './types';
import { AnalysisState, AnalysisResult } from './analysis-types';
import { parseCupFile } from './cup-parser';
import { haversineDistance, bearing, cardinalDirection } from './geo-utils';
import { MapManager } from './map-manager';
import { createMarkerIcon, buildTooltipText, buildDetailPanelHtml, buildAnalysisResultHtml, getStyleConfig } from './marker-factory';
import { analyzeLandingSite, promptForSettings } from './landing-analyzer';
import { fmtShortDist, getUnitSystem, setUnitSystem, UnitSystem, distSliderUnit, kmToSliderVal, sliderValToKm } from './units';

interface MarkerEntry {
  marker: L.Marker;
  waypoint: Waypoint;
  index: number;
}

export class UIController {
  private waypoints: Waypoint[] = [];
  private markers: MarkerEntry[] = [];
  private homeIndex: number | null = null;
  private maxDistanceKm = Infinity;
  private savedView: { center: L.LatLng; zoom: number } | null = null;

  private readonly overlay: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly detailPanel: HTMLElement;

  constructor(private readonly mapManager: MapManager) {
    this.overlay = document.getElementById('file-overlay')!;
    this.toolbar = document.getElementById('toolbar')!;
    this.fileInput = document.getElementById('file-input') as HTMLInputElement;
    this.detailPanel = document.getElementById('detail-panel')!;

    this.setupFileHandling();
    this.setupPopupDelegation();
    this.setupDetailDelegation();
  }

  private setupFileHandling(): void {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) this.loadFile(file);
    });

    // Drag and drop on the overlay
    this.overlay.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    this.overlay.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.cup')) {
        this.loadFile(file);
      }
    });
  }

  private setupPopupDelegation(): void {
    document.getElementById('map')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.popup-home-btn') as HTMLElement | null;
      if (btn) {
        const index = parseInt(btn.dataset.homeIndex!, 10);
        this.setHome(index);
      }
    });
  }

  private setupDetailDelegation(): void {
    this.detailPanel.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target.closest('#detail-back')) {
        this.exitDetailMode();
        return;
      }

      const analyzeBtn = target.closest('#analyze-btn') as HTMLElement | null;
      if (analyzeBtn) {
        const index = parseInt(analyzeBtn.dataset.wpIndex!, 10);
        this.runAnalysis(index);
        return;
      }

      const settingsLink = target.closest('#change-ollama-settings');
      if (settingsLink) {
        e.preventDefault();
        promptForSettings();
        return;
      }

      const homeBtn = target.closest('.popup-home-btn') as HTMLElement | null;
      if (homeBtn) {
        const index = parseInt(homeBtn.dataset.homeIndex!, 10);
        this.setHome(index);
        // Refresh detail panel with updated home info
        this.openDetailMode(index);
      }
    });
  }

  private openDetailMode(waypointIndex: number): void {
    const wp = this.waypoints[waypointIndex];
    const home = this.homeIndex !== null ? this.waypoints[this.homeIndex] : null;
    const homeInfo = home && waypointIndex !== this.homeIndex
      ? this.computeHomeInfo(wp, home)
      : undefined;

    // Save current map view so we can restore it
    if (!this.savedView) {
      this.savedView = {
        center: this.mapManager.map.getCenter(),
        zoom: this.mapManager.map.getZoom(),
      };
    }

    // Zoom to the waypoint
    this.mapManager.map.setView([wp.lat, wp.lon], 16, { animate: true });

    // Draw direction line to home
    this.mapManager.detailLayer.clearLayers();
    if (home && waypointIndex !== this.homeIndex) {
      const line = L.polyline(
        [[wp.lat, wp.lon], [home.lat, home.lon]],
        { color: '#ef4444', weight: 2, opacity: 0.7, dashArray: '8, 6' },
      );
      this.mapManager.detailLayer.addLayer(line);
    }

    // Show detail panel
    this.detailPanel.innerHTML = buildDetailPanelHtml(wp, waypointIndex, homeInfo);
    this.detailPanel.classList.remove('hidden');
    this.toolbar.classList.remove('visible');

    // Close any open popup
    this.mapManager.map.closePopup();
  }

  private exitDetailMode(): void {
    this.detailPanel.classList.add('hidden');
    this.toolbar.classList.add('visible');
    this.mapManager.detailLayer.clearLayers();

    if (this.savedView) {
      this.mapManager.map.setView(this.savedView.center, this.savedView.zoom, { animate: true });
      this.savedView = null;
    }
  }

  private async runAnalysis(waypointIndex: number): Promise<void> {
    const wp = this.waypoints[waypointIndex];

    this.updateAnalysisUI({ status: 'loading', message: 'Connecting to Ollama...' });

    try {
      const output = await analyzeLandingSite(wp, (message) => {
        this.updateAnalysisUI({ status: 'loading', message });
      });
      this.updateAnalysisUI({ status: 'success', result: output.result });
      try {
        this.drawAnalysisOverlays(wp, output.result, output.pixelToLatLon);
      } catch (overlayErr) {
        console.warn('Failed to draw analysis overlays:', overlayErr);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      this.updateAnalysisUI({ status: 'error', error: message });
    }
  }

  /**
   * Compute a lat/lon offset from a center point given distance in meters and bearing in degrees.
   */
  private offsetLatLon(
    lat: number, lon: number, distM: number, bearingDeg: number,
  ): L.LatLngTuple {
    const R = 6371000;
    const brng = (bearingDeg * Math.PI) / 180;
    const latR = (lat * Math.PI) / 180;
    const lonR = (lon * Math.PI) / 180;
    const d = distM / R;
    const lat2 = Math.asin(
      Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brng),
    );
    const lon2 = lonR + Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(latR),
      Math.cos(d) - Math.sin(latR) * Math.sin(lat2),
    );
    return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
  }

  /**
   * Safely convert pixel coords to lat/lon, returning null if result is NaN.
   */
  private safePixelToLatLon(
    pixelToLatLon: (px: number, py: number) => { lat: number; lon: number },
    px: number, py: number,
  ): L.LatLngTuple | null {
    const x = Number(px);
    const y = Number(py);
    if (!isFinite(x) || !isFinite(y) || x <= 0 || y <= 0) return null;
    const p = pixelToLatLon(x, y);
    if (!isFinite(p.lat) || !isFinite(p.lon)) return null;
    return [p.lat, p.lon];
  }

  private drawAnalysisOverlays(
    wp: Waypoint,
    result: AnalysisResult,
    pixelToLatLon: (px: number, py: number) => { lat: number; lon: number },
  ): void {
    const layer = this.mapManager.detailLayer;
    const area = result.landableArea;

    // Coerce dimensions to numbers (model may return strings)
    const lengthM = Number(area.lengthM) || 0;
    const widthM = Number(area.widthM) || 0;
    const orientDeg = Number(area.orientationDeg) || 0;
    const usableM = Number(area.usableLengthM) || 0;

    // Determine the actual field center — use AI-reported pixel center if valid,
    // otherwise fall back to waypoint location
    let fieldLat = wp.lat;
    let fieldLon = wp.lon;
    if (area.centerPixel) {
      const center = this.safePixelToLatLon(pixelToLatLon, area.centerPixel.x, area.centerPixel.y);
      if (center) {
        fieldLat = center[0];
        fieldLon = center[1];
      }
    }

    // Collect all overlay points so we can fit the map to show them
    const allPoints: L.LatLngTuple[] = [[fieldLat, fieldLon]];

    // Only draw if we have meaningful dimensions
    if (lengthM > 10 && widthM > 5) {
      // Use orientation from analysis, fall back to runway direction from .cup, then default 0
      let orient = orientDeg;
      if (orient === 0 && wp.rwdir > 0) orient = wp.rwdir;

      const halfLen = lengthM / 2;
      const halfWid = widthM / 2;

      // Compute runway endpoints along the orientation axis FROM THE FIELD CENTER
      const rwyEnd1 = this.offsetLatLon(fieldLat, fieldLon, halfLen, orient);
      const rwyEnd2 = this.offsetLatLon(fieldLat, fieldLon, halfLen, (orient + 180) % 360);

      // Compute 4 corners (rectangle around runway)
      const corner1 = this.offsetLatLon(rwyEnd1[0], rwyEnd1[1], halfWid, (orient + 90) % 360);
      const corner2 = this.offsetLatLon(rwyEnd1[0], rwyEnd1[1], halfWid, (orient + 270) % 360);
      const corner3 = this.offsetLatLon(rwyEnd2[0], rwyEnd2[1], halfWid, (orient + 270) % 360);
      const corner4 = this.offsetLatLon(rwyEnd2[0], rwyEnd2[1], halfWid, (orient + 90) % 360);

      allPoints.push(corner1, corner2, corner3, corner4);

      // Field polygon
      const polygon = L.polygon([corner1, corner2, corner3, corner4], {
        color: '#22c55e',
        weight: 3,
        fillColor: '#22c55e',
        fillOpacity: 0.15,
        dashArray: '8, 5',
      });
      layer.addLayer(polygon);

      // Length tape measure (along runway axis)
      this.drawTapeLine(layer, rwyEnd1, rwyEnd2, fmtShortDist(lengthM), '#3b82f6');

      // Width tape measure (perpendicular, at field center)
      const w1 = this.offsetLatLon(fieldLat, fieldLon, halfWid, (orient + 90) % 360);
      const w2 = this.offsetLatLon(fieldLat, fieldLon, halfWid, (orient + 270) % 360);
      this.drawTapeLine(layer, w1, w2, fmtShortDist(widthM), '#f59e0b');

      // Usable length indicator (solid green line, if different from total)
      if (usableM > 0 && usableM < lengthM) {
        const halfUsable = usableM / 2;
        const u1 = this.offsetLatLon(fieldLat, fieldLon, halfUsable, orient);
        const u2 = this.offsetLatLon(fieldLat, fieldLon, halfUsable, (orient + 180) % 360);
        layer.addLayer(L.polyline([u1, u2], {
          color: '#22c55e', weight: 5, opacity: 0.8,
        }));
      }
    }

    // Obstruction markers — use pixel positions if available, otherwise place by location text
    if (result.obstructions.length > 0) {
      const fieldRadius = Math.max(lengthM, widthM, 200) * 0.6;
      for (let i = 0; i < result.obstructions.length; i++) {
        const obs = result.obstructions[i];
        let pos: L.LatLngTuple;
        const pixelPos = obs.pixelPos
          ? this.safePixelToLatLon(pixelToLatLon, obs.pixelPos.x, obs.pixelPos.y)
          : null;
        if (pixelPos) {
          pos = pixelPos;
        } else {
          const angle = this.locationToAngle(obs.location, i, result.obstructions.length);
          pos = this.offsetLatLon(fieldLat, fieldLon, fieldRadius, angle);
        }
        allPoints.push(pos);

        const severityColor =
          obs.severity === 'critical' ? '#ef4444' :
          obs.severity === 'moderate' ? '#f59e0b' : '#94a3b8';
        const icon = L.divIcon({
          className: 'obstruction-map-icon',
          html: `<div class="obs-marker" style="background:${severityColor}">
            <span class="obs-marker-label">${this.obstructionIcon(obs.type)}</span>
          </div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const marker = L.marker(pos, { icon, interactive: true });
        marker.bindTooltip(
          `<b>${obs.type.replace(/_/g, ' ')}</b> (${obs.severity})<br>${obs.description}<br><i>${obs.location}</i>`,
          { direction: 'top', offset: [0, -14] },
        );
        layer.addLayer(marker);
      }
    }

    // Fit map to show the entire field + obstructions with padding for the detail panel
    if (allPoints.length > 1) {
      const bounds = L.latLngBounds(allPoints);
      this.mapManager.map.fitBounds(bounds, {
        paddingTopLeft: [20, 20],
        paddingBottomRight: [360, 20],  // account for detail panel on right
        maxZoom: 17,
        animate: true,
      });
    }
  }

  private drawTapeLine(
    layer: L.LayerGroup,
    from: L.LatLngTuple, to: L.LatLngTuple,
    label: string, color: string,
  ): void {
    // Main line
    layer.addLayer(L.polyline([from, to], { color, weight: 2, opacity: 0.9 }));

    // End tick marks (perpendicular short lines)
    const tickLen = 8; // meters
    const dx = to[1] - from[1];
    const dy = to[0] - from[0];
    const ang = (Math.atan2(dx, dy) * 180) / Math.PI;
    const perpA = (ang + 90) % 360;
    const perpB = (ang + 270) % 360;

    for (const end of [from, to]) {
      const t1 = this.offsetLatLon(end[0], end[1], tickLen, perpA);
      const t2 = this.offsetLatLon(end[0], end[1], tickLen, perpB);
      layer.addLayer(L.polyline([t1, t2], { color, weight: 2, opacity: 0.9 }));
    }

    // Label at midpoint
    const midLat = (from[0] + to[0]) / 2;
    const midLon = (from[1] + to[1]) / 2;
    const labelIcon = L.divIcon({
      className: 'tape-label-icon',
      html: `<div class="tape-label" style="background:${color}">${label}</div>`,
      iconSize: [70, 22],
      iconAnchor: [35, 11],
    });
    layer.addLayer(L.marker([midLat, midLon], { icon: labelIcon, interactive: false }));
  }

  /**
   * Convert a location description like "northern boundary" to a compass angle from center.
   */
  private locationToAngle(location: string, index: number, total: number): number {
    const loc = location.toLowerCase();
    if (loc.includes('north') && loc.includes('east')) return 45;
    if (loc.includes('north') && loc.includes('west')) return 315;
    if (loc.includes('south') && loc.includes('east')) return 135;
    if (loc.includes('south') && loc.includes('west')) return 225;
    if (loc.includes('north')) return 0;
    if (loc.includes('south')) return 180;
    if (loc.includes('east')) return 90;
    if (loc.includes('west')) return 270;
    // Fallback: distribute evenly around the field
    return (index / total) * 360;
  }

  private obstructionIcon(type: string): string {
    switch (type) {
      case 'power_line': return '\u26a1';
      case 'trees': return '\ud83c\udf33';
      case 'fence': return '\u2503';
      case 'building': return '\ud83c\udfe0';
      case 'road': return '\u2550';
      case 'water': return '\ud83c\udf0a';
      case 'terrain': return '\u26f0';
      default: return '\u26a0';
    }
  }

  private updateAnalysisUI(state: AnalysisState): void {
    const container = document.getElementById('analysis-result');
    const btn = document.getElementById('analyze-btn') as HTMLButtonElement | null;
    if (!container) return;

    switch (state.status) {
      case 'idle':
        container.innerHTML = '';
        if (btn) { btn.disabled = false; btn.textContent = 'Analyze Landing Site'; }
        break;
      case 'loading':
        if (btn) { btn.disabled = true; btn.textContent = state.message; }
        container.innerHTML = '<div class="analysis-spinner"></div>';
        break;
      case 'success':
        if (btn) { btn.disabled = false; btn.textContent = 'Re-analyze'; }
        container.innerHTML = buildAnalysisResultHtml(state.result);
        break;
      case 'error':
        if (btn) { btn.disabled = false; btn.textContent = 'Analyze Landing Site'; }
        container.innerHTML = `<div class="analysis-error">${state.error}</div>`;
        break;
    }
  }

  private loadFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      this.waypoints = parseCupFile(text);

      if (this.waypoints.length === 0) {
        alert('No waypoints found in this file.');
        return;
      }

      this.overlay.classList.add('hidden');
      this.homeIndex = null;
      this.maxDistanceKm = Infinity;
      this.buildToolbar();
      this.toolbar.classList.add('visible');
      this.placeMarkers();
      this.mapManager.fitToMarkers();
    };
    reader.readAsText(file);
  }

  private buildToolbar(): void {
    const homeOptions = this.waypoints
      .map((wp, i) => `<option value="${i}">${wp.name}${wp.code ? ` (${wp.code})` : ''}</option>`)
      .join('');

    const styleChecks = [
      WaypointStyle.GlidingAirfield,
      WaypointStyle.PavedAirfield,
      WaypointStyle.GrassAirfield,
      WaypointStyle.Outlanding,
      WaypointStyle.Unknown,
    ]
      .map((s) => {
        const config = getStyleConfig(s);
        return `<label><input type="checkbox" data-style="${s}" checked> ${config.label}</label>`;
      })
      .join('');

    const curUnits = getUnitSystem();
    const sliderUnit = distSliderUnit();

    this.toolbar.innerHTML = `
      <label>Home:
        <select id="home-select">
          <option value="">-- Select home --</option>
          ${homeOptions}
        </select>
      </label>
      <div class="toolbar-divider"></div>
      ${styleChecks}
      <div class="toolbar-divider"></div>
      <div class="distance-group" id="distance-group" style="display:none">
        <label>Max dist:</label>
        <input type="range" id="distance-slider" min="1" max="200" value="200">
        <span class="distance-value" id="distance-value">200 ${sliderUnit}</span>
      </div>
      <div class="toolbar-divider"></div>
      <label>Units:
        <select id="unit-select">
          <option value="metric" ${curUnits === 'metric' ? 'selected' : ''}>Metric (m/km)</option>
          <option value="imperial" ${curUnits === 'imperial' ? 'selected' : ''}>Imperial (ft/mi)</option>
          <option value="aviation" ${curUnits === 'aviation' ? 'selected' : ''}>Aviation (ft/nm)</option>
        </select>
      </label>
      <div class="toolbar-divider"></div>
      <span class="toolbar-stats" id="stats-text">${this.waypoints.length} waypoints</span>
      <button class="file-label" id="reload-btn" style="padding:4px 12px;font-size:12px">Load new file</button>
    `;

    document.getElementById('home-select')!.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val !== '') {
        this.setHome(parseInt(val, 10));
      }
    });

    this.toolbar.querySelectorAll<HTMLInputElement>('input[data-style]').forEach((cb) => {
      cb.addEventListener('change', () => this.applyFilters());
    });

    document.getElementById('distance-slider')!.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      this.maxDistanceKm = sliderValToKm(val);
      document.getElementById('distance-value')!.textContent = `${val} ${distSliderUnit()}`;
      this.applyFilters();
    });

    document.getElementById('unit-select')!.addEventListener('change', (e) => {
      setUnitSystem((e.target as HTMLSelectElement).value as UnitSystem);
      // Refresh all tooltips and rebuild toolbar to update labels
      this.refreshTooltips();
      this.buildToolbar();
      // Re-select home if set
      if (this.homeIndex !== null) {
        const select = document.getElementById('home-select') as HTMLSelectElement;
        select.value = String(this.homeIndex);
        document.getElementById('distance-group')!.style.display = 'flex';
      }
    });

    document.getElementById('reload-btn')!.addEventListener('click', () => {
      this.exitDetailMode();
      this.overlay.classList.remove('hidden');
      this.toolbar.classList.remove('visible');
      this.mapManager.clearWaypoints();
      this.fileInput.value = '';
    });
  }

  private refreshTooltips(): void {
    const home = this.homeIndex !== null ? this.waypoints[this.homeIndex] : null;
    for (const entry of this.markers) {
      const isHome = entry.index === this.homeIndex;
      const info = home && !isHome ? this.computeHomeInfo(entry.waypoint, home) : undefined;
      entry.marker.setTooltipContent(buildTooltipText(entry.waypoint, info));
    }
  }

  private placeMarkers(): void {
    this.mapManager.clearWaypoints();
    this.markers = [];

    this.waypoints.forEach((wp, i) => {
      const icon = createMarkerIcon(wp.style);
      const marker = L.marker([wp.lat, wp.lon], { icon });
      marker.bindTooltip(buildTooltipText(wp), {
        permanent: true,
        direction: 'top',
        offset: [0, -12],
        className: 'waypoint-label',
      });
      marker.on('click', () => this.openDetailMode(i));

      this.mapManager.waypointLayer.addLayer(marker);
      this.markers.push({ marker, waypoint: wp, index: i });
    });
  }

  private setHome(index: number): void {
    this.homeIndex = index;
    const home = this.waypoints[index];

    // Update the select dropdown
    const select = document.getElementById('home-select') as HTMLSelectElement;
    select.value = String(index);

    // Show distance filter
    document.getElementById('distance-group')!.style.display = 'flex';

    // Rebuild all markers with distance info, and set home marker icon
    this.mapManager.homeMarkerLayer.clearLayers();

    let maxDist = 0;
    for (const entry of this.markers) {
      const info = this.computeHomeInfo(entry.waypoint, home);
      if (info.distanceKm > maxDist) maxDist = info.distanceKm;

      const isHome = entry.index === index;
      entry.marker.setIcon(createMarkerIcon(entry.waypoint.style, isHome));
      entry.marker.setTooltipContent(buildTooltipText(entry.waypoint, isHome ? undefined : info));

      if (isHome) {
        // Also add to the home layer for visual emphasis
        const homeMarker = L.marker([home.lat, home.lon], {
          icon: createMarkerIcon(home.style, true),
          zIndexOffset: 1000,
          interactive: false,
        });
        this.mapManager.homeMarkerLayer.addLayer(homeMarker);
      }
    }

    // Update distance slider max (convert km to display units)
    const slider = document.getElementById('distance-slider') as HTMLInputElement;
    const maxDisplayVal = Math.max(kmToSliderVal(maxDist), 10);
    const roundedMax = Math.ceil(maxDisplayVal / 10) * 10;
    slider.max = String(roundedMax);
    slider.value = slider.max;
    this.maxDistanceKm = sliderValToKm(roundedMax);
    document.getElementById('distance-value')!.textContent = `${roundedMax} ${distSliderUnit()}`;

    this.applyFilters();
    this.mapManager.map.closePopup();
  }

  private computeHomeInfo(wp: Waypoint, home: Waypoint): HomeInfo {
    const distanceKm = haversineDistance(home.lat, home.lon, wp.lat, wp.lon);
    const bearingDeg = bearing(home.lat, home.lon, wp.lat, wp.lon);
    const cardinalDir = cardinalDirection(bearingDeg);
    return { distanceKm, bearingDeg, cardinalDir };
  }

  private applyFilters(): void {
    const visibleStyles = new Set<number>();
    this.toolbar.querySelectorAll<HTMLInputElement>('input[data-style]').forEach((cb) => {
      if (cb.checked) visibleStyles.add(parseInt(cb.dataset.style!, 10));
    });

    const home = this.homeIndex !== null ? this.waypoints[this.homeIndex] : null;
    let visibleCount = 0;

    for (const entry of this.markers) {
      let visible = visibleStyles.has(entry.waypoint.style);

      // Distance filter (only when home is set)
      if (visible && home && entry.index !== this.homeIndex) {
        const dist = haversineDistance(home.lat, home.lon, entry.waypoint.lat, entry.waypoint.lon);
        if (dist > this.maxDistanceKm) visible = false;
      }

      if (visible) {
        if (!this.mapManager.waypointLayer.hasLayer(entry.marker)) {
          this.mapManager.waypointLayer.addLayer(entry.marker);
        }
        visibleCount++;
      } else {
        this.mapManager.waypointLayer.removeLayer(entry.marker);
      }
    }

    document.getElementById('stats-text')!.textContent =
      `${visibleCount} / ${this.waypoints.length} waypoints`;
  }
}
