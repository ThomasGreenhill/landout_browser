import L from 'leaflet';
import { Waypoint, WaypointStyle, HomeInfo } from './types';
import { AnalysisState, AnalysisResult, PixelPoint } from './analysis-types';
import { parseCupFile } from './cup-parser';
import { haversineDistance, bearing, cardinalDirection } from './geo-utils';
import { MapManager } from './map-manager';
import { createMarkerIcon, buildTooltipText, buildDetailPanelHtml, buildAnalysisResultHtml, getStyleConfig } from './marker-factory';
import { analyzeLandingSite, promptForSettings, AnalysisOutput } from './landing-analyzer';

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
      this.drawAnalysisOverlays(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      this.updateAnalysisUI({ status: 'error', error: message });
    }
  }

  private drawAnalysisOverlays(output: AnalysisOutput): void {
    const { result, pixelToLatLon } = output;
    // Keep existing layers (e.g. home line), add analysis overlays
    const layer = this.mapManager.detailLayer;

    // Draw landing area polygon
    const corners = result.landableArea.corners;
    if (corners && corners.length >= 3) {
      const latlngs = corners.map((c) => {
        const p = pixelToLatLon(c.x, c.y);
        return [p.lat, p.lon] as L.LatLngTuple;
      });
      // Close the polygon
      const polygon = L.polygon(latlngs, {
        color: '#22c55e',
        weight: 2,
        fillColor: '#22c55e',
        fillOpacity: 0.15,
        dashArray: '6, 4',
      });
      layer.addLayer(polygon);

      // Draw tape-measure lines for length and width
      if (corners.length === 4) {
        this.drawTapeMeasure(layer, corners, pixelToLatLon, result);
      }
    }

    // Draw obstruction markers
    for (const obs of result.obstructions) {
      if (obs.pixelPos && obs.pixelPos.x > 0 && obs.pixelPos.y > 0) {
        const p = pixelToLatLon(obs.pixelPos.x, obs.pixelPos.y);
        const severityColor =
          obs.severity === 'critical' ? '#ef4444' :
          obs.severity === 'moderate' ? '#f59e0b' : '#94a3b8';
        const icon = L.divIcon({
          className: 'obstruction-map-icon',
          html: `<div class="obs-marker" style="background:${severityColor}">
            <span class="obs-marker-label">${this.obstructionIcon(obs.type)}</span>
          </div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const marker = L.marker([p.lat, p.lon], { icon, interactive: true });
        marker.bindTooltip(
          `<b>${obs.type.replace(/_/g, ' ')}</b><br>${obs.description}`,
          { direction: 'top', offset: [0, -12] },
        );
        layer.addLayer(marker);
      }
    }
  }

  private drawTapeMeasure(
    layer: L.LayerGroup,
    corners: PixelPoint[],
    pixelToLatLon: (px: number, py: number) => { lat: number; lon: number },
    result: AnalysisResult,
  ): void {
    // Corners are typically ordered: 0-1 is one side, 1-2 is adjacent side
    // Find the two longest edges to determine length vs width
    const edges: Array<{ from: number; to: number; dist: number }> = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const dx = corners[j].x - corners[i].x;
      const dy = corners[j].y - corners[i].y;
      edges.push({ from: i, to: j, dist: Math.sqrt(dx * dx + dy * dy) });
    }
    edges.sort((a, b) => b.dist - a.dist);

    // Longest edge pair = length, shorter pair = width
    const lengthEdge = edges[0];
    const widthEdge = edges.find(e =>
      e.from !== lengthEdge.from && e.to !== lengthEdge.from &&
      e.from !== lengthEdge.to && e.to !== lengthEdge.to
    ) || edges[2];

    // Draw length tape
    this.drawSingleTape(layer, corners[lengthEdge.from], corners[lengthEdge.to],
      `${result.landableArea.lengthM}m`, '#3b82f6', pixelToLatLon);

    // Draw width tape
    this.drawSingleTape(layer, corners[widthEdge.from], corners[widthEdge.to],
      `${result.landableArea.widthM}m`, '#f59e0b', pixelToLatLon);
  }

  private drawSingleTape(
    layer: L.LayerGroup,
    from: PixelPoint, to: PixelPoint,
    label: string, color: string,
    pixelToLatLon: (px: number, py: number) => { lat: number; lon: number },
  ): void {
    const p1 = pixelToLatLon(from.x, from.y);
    const p2 = pixelToLatLon(to.x, to.y);

    // The measurement line
    const line = L.polyline(
      [[p1.lat, p1.lon], [p2.lat, p2.lon]],
      { color, weight: 2, opacity: 0.9 },
    );
    layer.addLayer(line);

    // End caps (perpendicular ticks) — draw as small offset markers
    const midLat = (p1.lat + p2.lat) / 2;
    const midLon = (p1.lon + p2.lon) / 2;

    const labelIcon = L.divIcon({
      className: 'tape-label-icon',
      html: `<div class="tape-label" style="background:${color}">${label}</div>`,
      iconSize: [60, 20],
      iconAnchor: [30, 10],
    });
    const labelMarker = L.marker([midLat, midLon], { icon: labelIcon, interactive: false });
    layer.addLayer(labelMarker);
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
        <span class="distance-value" id="distance-value">200 km</span>
      </div>
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
      this.maxDistanceKm = val;
      document.getElementById('distance-value')!.textContent = `${val} km`;
      this.applyFilters();
    });

    document.getElementById('reload-btn')!.addEventListener('click', () => {
      this.exitDetailMode();
      this.overlay.classList.remove('hidden');
      this.toolbar.classList.remove('visible');
      this.mapManager.clearWaypoints();
      this.fileInput.value = '';
    });
  }

  private placeMarkers(): void {
    this.mapManager.clearWaypoints();
    this.markers = [];

    this.waypoints.forEach((wp, i) => {
      const icon = createMarkerIcon(wp.style);
      const marker = L.marker([wp.lat, wp.lon], { icon });
      marker.bindTooltip(buildTooltipText(wp), {
        direction: 'top',
        offset: [0, -12],
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

    // Update distance slider max
    const slider = document.getElementById('distance-slider') as HTMLInputElement;
    const maxVal = Math.ceil(maxDist / 10) * 10;
    slider.max = String(Math.max(maxVal, 10));
    slider.value = slider.max;
    this.maxDistanceKm = maxVal;
    document.getElementById('distance-value')!.textContent = `${slider.max} km`;

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
