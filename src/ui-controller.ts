import L from 'leaflet';
import { Waypoint, WaypointStyle, HomeInfo } from './types';
import { parseCupFile } from './cup-parser';
import { haversineDistance, bearing, cardinalDirection } from './geo-utils';
import { MapManager } from './map-manager';
import { createMarkerIcon, buildTooltipText, buildDetailPanelHtml, buildDetectionResultHtml, getStyleConfig } from './marker-factory';
import { fetchTilesForWaypoint, detectFromRunwayData, detectFromEndpoints, getAiDescription, promptForSettings, DetectionOutput, CompositeResult, getSavedStrip, saveStrip } from './landing-analyzer';
import { fmtShortDist, getUnitSystem, setUnitSystem, UnitSystem, distSliderUnit, kmToSliderVal, sliderValToKm } from './units';
import { getElevationProfile } from './terrain';

function formatAiText(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

interface MarkerEntry { marker: L.Marker; waypoint: Waypoint; index: number; }

export class UIController {
  private waypoints: Waypoint[] = [];
  private markers: MarkerEntry[] = [];
  private homeIndex: number | null = null;
  private maxDistanceKm = Infinity;
  private savedView: { center: L.LatLng; zoom: number } | null = null;
  private lastDetectionOutput: DetectionOutput | null = null;
  private pendingComposite: { waypointIndex: number; composite: CompositeResult } | null = null;
  private mapClickHandler: ((e: L.LeafletMouseEvent) => void) | null = null;

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
    this.overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    this.overlay.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.cup')) this.loadFile(file);
    });
  }

  private setupPopupDelegation(): void {
    document.getElementById('map')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.popup-home-btn') as HTMLElement | null;
      if (btn) this.setHome(parseInt(btn.dataset.homeIndex!, 10));
    });
  }

  private setupDetailDelegation(): void {
    this.detailPanel.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('#detail-back')) { this.exitDetailMode(); return; }

      const detectBtn = target.closest('#detect-btn') as HTMLElement | null;
      if (detectBtn) { this.startDetection(parseInt(detectBtn.dataset.wpIndex!, 10)); return; }

      const aiBtn = target.closest('#ai-describe-btn') as HTMLElement | null;
      if (aiBtn) { this.runAiDescription(parseInt(aiBtn.dataset.wpIndex!, 10)); return; }

      if (target.closest('#change-ollama-settings')) { e.preventDefault(); promptForSettings(); return; }

      const homeBtn = target.closest('.popup-home-btn') as HTMLElement | null;
      if (homeBtn) { this.setHome(parseInt(homeBtn.dataset.homeIndex!, 10)); this.openDetailMode(parseInt(homeBtn.dataset.homeIndex!, 10)); }
    });
  }

  private openDetailMode(waypointIndex: number): void {
    const wp = this.waypoints[waypointIndex];
    const home = this.homeIndex !== null ? this.waypoints[this.homeIndex] : null;
    const homeInfo = home && waypointIndex !== this.homeIndex ? this.computeHomeInfo(wp, home) : undefined;
    if (!this.savedView) {
      this.savedView = { center: this.mapManager.map.getCenter(), zoom: this.mapManager.map.getZoom() };
    }
    this.mapManager.map.setView([wp.lat, wp.lon], 16, { animate: true });
    this.mapManager.detailLayer.clearLayers();
    if (home && waypointIndex !== this.homeIndex) {
      this.mapManager.detailLayer.addLayer(L.polyline(
        [[wp.lat, wp.lon], [home.lat, home.lon]],
        { color: '#ef4444', weight: 2, opacity: 0.7, dashArray: '8, 6' },
      ));
    }
    this.detailPanel.innerHTML = buildDetailPanelHtml(wp, waypointIndex, homeInfo);
    this.detailPanel.classList.remove('hidden');
    this.toolbar.classList.remove('visible');
    this.mapManager.map.closePopup();

    // Check for saved strip and show it immediately
    const saved = getSavedStrip(wp.lat, wp.lon);
    if (saved) {
      this.showSavedStrip(wp, waypointIndex, saved);
    }
  }

  private async showSavedStrip(wp: Waypoint, waypointIndex: number, saved: { lat1: number; lon1: number; lat2: number; lon2: number; widthM: number }): Promise<void> {
    const container = document.getElementById('analysis-result');
    if (!container) return;
    let composite: CompositeResult;
    if (this.pendingComposite && this.pendingComposite.waypointIndex === waypointIndex) {
      composite = this.pendingComposite.composite;
    } else {
      composite = await fetchTilesForWaypoint(wp, () => {});
      this.pendingComposite = { waypointIndex, composite };
    }
    const detection = detectFromEndpoints(wp, composite, saved.lat1, saved.lon1, saved.lat2, saved.lon2, saved.widthM);
    this.lastDetectionOutput = { detection, composite };
    container.innerHTML = buildDetectionResultHtml(detection, waypointIndex);
    try { this.drawDetectionOverlays(this.lastDetectionOutput); } catch (e) { console.warn(e); }
    this.fetchTerrainProfile(detection, composite);
  }

  private exitDetailMode(): void {
    this.clearMapClickHandler();
    this.detailPanel.classList.add('hidden');
    this.toolbar.classList.add('visible');
    this.mapManager.detailLayer.clearLayers();
    this.lastDetectionOutput = null;
    this.pendingComposite = null;
    if (this.savedView) {
      this.mapManager.map.setView(this.savedView.center, this.savedView.zoom, { animate: true });
      this.savedView = null;
    }
  }

  // --- Landing strip identification ---

  private async startDetection(waypointIndex: number): Promise<void> {
    const wp = this.waypoints[waypointIndex];
    const detectBtn = document.getElementById('detect-btn') as HTMLButtonElement | null;
    const container = document.getElementById('analysis-result')!;
    this.clearMapClickHandler();

    if (detectBtn) { detectBtn.disabled = true; detectBtn.textContent = 'Fetching tiles...'; }
    container.innerHTML = '<div class="analysis-spinner"></div>';

    try {
      let composite: CompositeResult;
      if (this.pendingComposite && this.pendingComposite.waypointIndex === waypointIndex) {
        composite = this.pendingComposite.composite;
      } else {
        composite = await fetchTilesForWaypoint(wp, (msg) => { if (detectBtn) detectBtn.textContent = msg; });
        this.pendingComposite = { waypointIndex, composite };
      }

      const hasRunway = wp.rwdir > 0 && wp.rwlen > 0;

      if (hasRunway) {
        // Single-click: place runway center
        if (detectBtn) { detectBtn.disabled = true; detectBtn.textContent = 'Click runway center on map...'; }
        container.innerHTML = '<div class="analysis-field"><div class="analysis-field-header">Click the runway center</div><div class="analysis-field-detail">We have heading ' + wp.rwdir + '&deg; and length ' + Math.round(wp.rwlen) + 'm from the file. Click to place the center.</div></div>';
        this.mapManager.map.getContainer().style.cursor = 'crosshair';

        this.mapClickHandler = (e: L.LeafletMouseEvent) => {
          this.clearMapClickHandler();
          const detection = detectFromRunwayData(wp, composite, e.latlng.lat, e.latlng.lng);
          this.lastDetectionOutput = { detection, composite };
          container.innerHTML = buildDetectionResultHtml(detection, waypointIndex);
          if (detectBtn) { detectBtn.disabled = false; detectBtn.textContent = 'Re-place Runway'; }
          try { this.drawDetectionOverlays(this.lastDetectionOutput); } catch (err) { console.warn(err); }
          this.fetchTerrainProfile(detection, composite);
        };
        this.mapManager.map.once('click', this.mapClickHandler);

      } else {
        // Two-click: draw strip endpoints
        if (detectBtn) { detectBtn.disabled = true; detectBtn.textContent = 'Click START of landing run...'; }
        container.innerHTML = '<div class="analysis-field"><div class="analysis-field-header">Click the START of the landing run</div><div class="analysis-field-detail">Click one end of the field or strip on the satellite image.</div></div>';
        this.mapManager.map.getContainer().style.cursor = 'crosshair';

        this.mapClickHandler = (e: L.LeafletMouseEvent) => {
          const startLatLng = e.latlng;
          // Draw a marker at the start point
          const startMarker = L.circleMarker([startLatLng.lat, startLatLng.lng], {
            radius: 6, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1, weight: 2,
          });
          this.mapManager.detailLayer.addLayer(startMarker);

          if (detectBtn) detectBtn.textContent = 'Click END of landing run...';
          container.innerHTML = '<div class="analysis-field"><div class="analysis-field-header">Click the END of the landing run</div><div class="analysis-field-detail">Click the other end of the field or strip.</div></div>';

          // Second click handler
          this.mapClickHandler = (e2: L.LeafletMouseEvent) => {
            this.clearMapClickHandler();
            const endLatLng = e2.latlng;

            const detection = detectFromEndpoints(
              wp, composite,
              startLatLng.lat, startLatLng.lng,
              endLatLng.lat, endLatLng.lng,
              30, // default 30m width
            );
            this.lastDetectionOutput = { detection, composite };

            // Save for persistence
            saveStrip(wp.lat, wp.lon, {
              lat1: startLatLng.lat, lon1: startLatLng.lng,
              lat2: endLatLng.lat, lon2: endLatLng.lng,
              widthM: 30,
            });

            container.innerHTML = buildDetectionResultHtml(detection, waypointIndex);
            if (detectBtn) { detectBtn.disabled = false; detectBtn.textContent = 'Re-draw Strip'; }
            try { this.drawDetectionOverlays(this.lastDetectionOutput); } catch (err) { console.warn(err); }
            this.fetchTerrainProfile(detection, composite);
          };
          this.mapManager.map.once('click', this.mapClickHandler);
        };
        this.mapManager.map.once('click', this.mapClickHandler);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      container.innerHTML = `<div class="analysis-error">${msg}</div>`;
      if (detectBtn) { detectBtn.disabled = false; detectBtn.textContent = hasRunway(wp) ? 'Place Runway' : 'Draw Landing Strip'; }
    }
  }

  private clearMapClickHandler(): void {
    if (this.mapClickHandler) {
      this.mapManager.map.off('click', this.mapClickHandler);
      this.mapClickHandler = null;
    }
    this.mapManager.map.getContainer().style.cursor = '';
  }

  private fetchTerrainProfile(detection: import('./field-detector').FieldDetection, composite: CompositeResult): void {
    if (detection.lengthM < 30) return;
    const terrainEl = document.getElementById('terrain-profile');
    if (!terrainEl) return;
    terrainEl.innerHTML = '<span style="color:rgba(255,255,255,0.4);font-size:11px">Loading terrain...</span>';
    const center = composite.pixelToLatLon(detection.centerPixel.x, detection.centerPixel.y);
    getElevationProfile(center.lat, center.lon, detection.orientationDeg, detection.lengthM)
      .then((profile) => {
        let html = `<div class="analysis-field-value">${profile.avgSlopePercent}% avg slope, ${profile.maxSlopePercent}% max</div>`;
        if (!profile.isFlat) {
          html += `<div class="analysis-error" style="margin-top:2px">&#9888; Terrain may be too sloped (&gt;3%)</div>`;
        } else {
          html += `<div class="analysis-field-detail" style="color:#22c55e">Terrain is flat enough for landing</div>`;
        }
        const elevs = profile.samples.map(s => s.elevM);
        const minE = Math.min(...elevs), maxE = Math.max(...elevs);
        const range = Math.max(maxE - minE, 1);
        const barHtml = elevs.map(e => {
          const h = Math.round(((e - minE) / range) * 30 + 2);
          return `<div style="width:${Math.floor(100 / elevs.length)}%;height:${h}px;background:#3b82f6;border-radius:1px"></div>`;
        }).join('');
        html += `<div style="display:flex;align-items:end;gap:1px;height:34px;margin-top:6px">${barHtml}</div>`;
        html += `<div class="analysis-field-detail">${Math.round(minE)}m — ${Math.round(maxE)}m elev (${Math.round(maxE - minE)}m range)</div>`;
        terrainEl.innerHTML = html;
      })
      .catch(() => { terrainEl.innerHTML = '<span style="color:rgba(255,255,255,0.3);font-size:11px">Terrain data unavailable</span>'; });
  }

  // --- Optional AI description ---

  private async runAiDescription(waypointIndex: number): Promise<void> {
    const wp = this.waypoints[waypointIndex];
    const aiBtn = document.getElementById('ai-describe-btn') as HTMLButtonElement | null;
    const aiContainer = document.getElementById('ai-description');
    if (!this.lastDetectionOutput || !aiContainer) return;
    if (aiBtn) { aiBtn.disabled = true; aiBtn.textContent = 'Connecting to Ollama...'; }
    aiContainer.innerHTML = '<div class="analysis-spinner"></div>';
    try {
      const text = await getAiDescription(wp, this.lastDetectionOutput.composite, (msg) => { if (aiBtn) aiBtn.textContent = msg; });
      aiContainer.innerHTML = `<div class="ai-desc-text">${formatAiText(text)}</div>`;
      if (aiBtn) { aiBtn.disabled = false; aiBtn.textContent = 'Refresh AI Description'; }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI description failed';
      aiContainer.innerHTML = `<div class="analysis-error">${msg}</div>`;
      if (aiBtn) { aiBtn.disabled = false; aiBtn.textContent = 'Get AI Description'; }
    }
  }

  // --- Draw detection results on map ---

  private drawDetectionOverlays(output: DetectionOutput): void {
    const layer = this.mapManager.detailLayer;
    // Clear previous overlays but keep home line
    layer.clearLayers();
    // Re-add home line if needed
    if (this.homeIndex !== null) {
      const wp = this.waypoints[output.detection.orientationDeg !== undefined ? 0 : 0]; // dummy
      void wp;
    }

    const { detection, composite } = output;
    const allPoints: L.LatLngTuple[] = [];

    // Draw polygon from lat/lon corners directly (no pixel round-trip)
    if (detection.boundaryLatLons && detection.boundaryLatLons.length >= 3) {
      const latlngs: L.LatLngTuple[] = detection.boundaryLatLons.map((c) => {
        const tuple: L.LatLngTuple = [c[0], c[1]];
        allPoints.push(tuple);
        return tuple;
      });
      layer.addLayer(L.polygon(latlngs, {
        color: '#22c55e', weight: 3, fillColor: '#22c55e', fillOpacity: 0.12,
      }));
    }

    if (detection.lengthM > 10) {
      // Use actual endpoints if available, otherwise compute from center
      let end1: L.LatLngTuple, end2: L.LatLngTuple;
      if (detection.endpoint1 && detection.endpoint2) {
        end1 = [detection.endpoint1.lat, detection.endpoint1.lon];
        end2 = [detection.endpoint2.lat, detection.endpoint2.lon];
      } else {
        const center = composite.pixelToLatLon(detection.centerPixel.x, detection.centerPixel.y);
        const orient = detection.orientationDeg;
        const halfLen = detection.lengthM / 2;
        end1 = this.offsetLatLon(center.lat, center.lon, halfLen, orient);
        end2 = this.offsetLatLon(center.lat, center.lon, halfLen, (orient + 180) % 360);
      }
      this.drawTapeLine(layer, end1, end2, fmtShortDist(detection.lengthM), '#3b82f6');

      // Width tape at midpoint
      if (detection.widthM > 5) {
        const midLat = (end1[0] + end2[0]) / 2, midLon = (end1[1] + end2[1]) / 2;
        const orient = detection.orientationDeg;
        const halfWid = detection.widthM / 2;
        const w1 = this.offsetLatLon(midLat, midLon, halfWid, (orient + 90) % 360);
        const w2 = this.offsetLatLon(midLat, midLon, halfWid, (orient + 270) % 360);
        this.drawTapeLine(layer, w1, w2, fmtShortDist(detection.widthM), '#f59e0b');
      }

      // Endpoint markers
      layer.addLayer(L.circleMarker(end1, { radius: 5, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1, weight: 2 }));
      layer.addLayer(L.circleMarker(end2, { radius: 5, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1, weight: 2 }));
    }

    if (allPoints.length > 1) {
      this.mapManager.map.fitBounds(L.latLngBounds(allPoints), {
        paddingTopLeft: [20, 20], paddingBottomRight: [360, 20], maxZoom: 17, animate: true,
      });
    }
  }

  // --- Helpers ---

  private offsetLatLon(lat: number, lon: number, distM: number, bearingDeg: number): L.LatLngTuple {
    const R = 6371000;
    const brng = (bearingDeg * Math.PI) / 180;
    const latR = (lat * Math.PI) / 180;
    const lonR = (lon * Math.PI) / 180;
    const d = distM / R;
    const lat2 = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brng));
    const lon2 = lonR + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(lat2));
    return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
  }

  private drawTapeLine(layer: L.LayerGroup, from: L.LatLngTuple, to: L.LatLngTuple, label: string, color: string): void {
    layer.addLayer(L.polyline([from, to], { color, weight: 2, opacity: 0.9 }));
    const tickLen = 8;
    const dx = to[1] - from[1], dy = to[0] - from[0];
    const ang = (Math.atan2(dx, dy) * 180) / Math.PI;
    for (const end of [from, to]) {
      const t1 = this.offsetLatLon(end[0], end[1], tickLen, (ang + 90) % 360);
      const t2 = this.offsetLatLon(end[0], end[1], tickLen, (ang + 270) % 360);
      layer.addLayer(L.polyline([t1, t2], { color, weight: 2, opacity: 0.9 }));
    }
    const midLat = (from[0] + to[0]) / 2, midLon = (from[1] + to[1]) / 2;
    layer.addLayer(L.marker([midLat, midLon], {
      icon: L.divIcon({
        className: 'tape-label-icon',
        html: `<div class="tape-label" style="background:${color}">${label}</div>`,
        iconSize: [70, 22], iconAnchor: [35, 11],
      }),
      interactive: false,
    }));
  }

  // --- File loading, toolbar, markers, filters ---

  private loadFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      this.waypoints = parseCupFile(text);
      if (this.waypoints.length === 0) { alert('No waypoints found in this file.'); return; }
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
      WaypointStyle.GlidingAirfield, WaypointStyle.PavedAirfield,
      WaypointStyle.GrassAirfield, WaypointStyle.Outlanding, WaypointStyle.Unknown,
    ].map((s) => {
      const config = getStyleConfig(s);
      return `<label><input type="checkbox" data-style="${s}" checked> ${config.label}</label>`;
    }).join('');
    const curUnits = getUnitSystem();
    const sliderUnit = distSliderUnit();

    this.toolbar.innerHTML = `
      <label>Home: <select id="home-select"><option value="">-- Select home --</option>${homeOptions}</select></label>
      <div class="toolbar-divider"></div>${styleChecks}<div class="toolbar-divider"></div>
      <div class="distance-group" id="distance-group" style="display:none">
        <label>Max dist:</label><input type="range" id="distance-slider" min="1" max="200" value="200">
        <span class="distance-value" id="distance-value">200 ${sliderUnit}</span>
      </div><div class="toolbar-divider"></div>
      <label>Units: <select id="unit-select">
        <option value="metric" ${curUnits === 'metric' ? 'selected' : ''}>Metric (m/km)</option>
        <option value="imperial" ${curUnits === 'imperial' ? 'selected' : ''}>Imperial (ft/mi)</option>
        <option value="aviation" ${curUnits === 'aviation' ? 'selected' : ''}>Aviation (ft/nm)</option>
      </select></label><div class="toolbar-divider"></div>
      <span class="toolbar-stats" id="stats-text">${this.waypoints.length} waypoints</span>
      <button class="file-label" id="reload-btn" style="padding:4px 12px;font-size:12px">Load new file</button>`;

    document.getElementById('home-select')!.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val !== '') this.setHome(parseInt(val, 10));
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
      this.refreshTooltips();
      this.buildToolbar();
      if (this.homeIndex !== null) {
        (document.getElementById('home-select') as HTMLSelectElement).value = String(this.homeIndex);
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
        permanent: true, direction: 'top', offset: [0, -12], className: 'waypoint-label',
      });
      marker.on('click', () => this.openDetailMode(i));
      this.mapManager.waypointLayer.addLayer(marker);
      this.markers.push({ marker, waypoint: wp, index: i });
    });
  }

  private setHome(index: number): void {
    this.homeIndex = index;
    const home = this.waypoints[index];
    (document.getElementById('home-select') as HTMLSelectElement).value = String(index);
    document.getElementById('distance-group')!.style.display = 'flex';
    this.mapManager.homeMarkerLayer.clearLayers();
    let maxDist = 0;
    for (const entry of this.markers) {
      const info = this.computeHomeInfo(entry.waypoint, home);
      if (info.distanceKm > maxDist) maxDist = info.distanceKm;
      const isHome = entry.index === index;
      entry.marker.setIcon(createMarkerIcon(entry.waypoint.style, isHome));
      entry.marker.setTooltipContent(buildTooltipText(entry.waypoint, isHome ? undefined : info));
      if (isHome) {
        this.mapManager.homeMarkerLayer.addLayer(L.marker([home.lat, home.lon], {
          icon: createMarkerIcon(home.style, true), zIndexOffset: 1000, interactive: false,
        }));
      }
    }
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
    return {
      distanceKm: haversineDistance(home.lat, home.lon, wp.lat, wp.lon),
      bearingDeg: bearing(home.lat, home.lon, wp.lat, wp.lon),
      cardinalDir: cardinalDirection(bearing(home.lat, home.lon, wp.lat, wp.lon)),
    };
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
      if (visible && home && entry.index !== this.homeIndex) {
        if (haversineDistance(home.lat, home.lon, entry.waypoint.lat, entry.waypoint.lon) > this.maxDistanceKm) visible = false;
      }
      if (visible) {
        if (!this.mapManager.waypointLayer.hasLayer(entry.marker)) this.mapManager.waypointLayer.addLayer(entry.marker);
        visibleCount++;
      } else {
        this.mapManager.waypointLayer.removeLayer(entry.marker);
      }
    }
    document.getElementById('stats-text')!.textContent = `${visibleCount} / ${this.waypoints.length} waypoints`;
  }
}

function hasRunway(wp: Waypoint): boolean {
  return wp.rwdir > 0 && wp.rwlen > 0;
}
