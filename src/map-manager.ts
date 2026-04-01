import L from 'leaflet';

export class MapManager {
  readonly map: L.Map;
  readonly waypointLayer = L.layerGroup();
  readonly homeMarkerLayer = L.layerGroup();
  readonly detailLayer = L.layerGroup();
  readonly measureLayer = L.layerGroup();

  private measurePoints: L.LatLng[] = [];
  private measureLine: L.Polyline | null = null;
  private measuring = false;

  constructor(elementId: string) {
    this.map = L.map(elementId, {
      center: [47, 13],
      zoom: 7,
      zoomControl: true,
    });

    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution:
          'Tiles &copy; Esri &mdash; Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS User Community',
        maxZoom: 19,
      },
    );

    const labels = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, pane: 'overlayPane' },
    );

    satellite.addTo(this.map);
    labels.addTo(this.map);

    this.waypointLayer.addTo(this.map);
    this.homeMarkerLayer.addTo(this.map);
    this.detailLayer.addTo(this.map);
    this.measureLayer.addTo(this.map);

    L.control.layers(
      { 'Satellite': satellite },
      { 'Place names': labels },
    ).addTo(this.map);

    this.setupMeasureTool();
  }

  fitToMarkers(): void {
    const layers = this.waypointLayer.getLayers();
    if (layers.length === 0) return;
    const group = L.featureGroup(layers as L.Layer[]);
    this.map.fitBounds(group.getBounds(), { padding: [50, 50] });
  }

  clearWaypoints(): void {
    this.waypointLayer.clearLayers();
    this.homeMarkerLayer.clearLayers();
  }

  private setupMeasureTool(): void {
    // Right-click to add measure points
    this.map.on('contextmenu', (e: L.LeafletMouseEvent) => {
      e.originalEvent.preventDefault();

      if (!this.measuring) {
        // Start new measurement
        this.measuring = true;
        this.measureLayer.clearLayers();
        this.measurePoints = [e.latlng];
        this.addMeasurePoint(e.latlng);

        // Show hint
        this.showMeasureHint('Right-click to add points. Click the distance label to finish.');
      } else {
        // Add point to measurement
        this.measurePoints.push(e.latlng);
        this.addMeasurePoint(e.latlng);
        this.updateMeasureLine();
      }
    });

    // ESC to cancel measurement
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.measuring) {
        this.clearMeasure();
      }
    });
  }

  private addMeasurePoint(latlng: L.LatLng): void {
    const pointIcon = L.divIcon({
      className: 'measure-point-icon',
      html: '<div class="measure-point"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    const marker = L.marker(latlng, { icon: pointIcon, interactive: false });
    this.measureLayer.addLayer(marker);
  }

  private updateMeasureLine(): void {
    // Remove old line
    if (this.measureLine) {
      this.measureLayer.removeLayer(this.measureLine);
    }

    if (this.measurePoints.length < 2) return;

    // Draw polyline through all points
    this.measureLine = L.polyline(
      this.measurePoints.map((p) => [p.lat, p.lng] as L.LatLngTuple),
      { color: '#fff', weight: 2, opacity: 0.9, dashArray: '6, 4' },
    );
    this.measureLayer.addLayer(this.measureLine);

    // Calculate total distance
    let totalDist = 0;
    for (let i = 1; i < this.measurePoints.length; i++) {
      totalDist += this.measurePoints[i - 1].distanceTo(this.measurePoints[i]);
    }

    // Add segment labels
    this.measureLayer.getLayers()
      .filter((l) => (l as L.Marker).options && (l as unknown as Record<string, unknown>)._isMeasureLabel)
      .forEach((l) => this.measureLayer.removeLayer(l));

    // Segment distances
    for (let i = 1; i < this.measurePoints.length; i++) {
      const segDist = this.measurePoints[i - 1].distanceTo(this.measurePoints[i]);
      const midLat = (this.measurePoints[i - 1].lat + this.measurePoints[i].lat) / 2;
      const midLng = (this.measurePoints[i - 1].lng + this.measurePoints[i].lng) / 2;
      const segLabel = this.formatDistance(segDist);

      const icon = L.divIcon({
        className: 'tape-label-icon',
        html: `<div class="measure-segment-label">${segLabel}</div>`,
        iconSize: [80, 20],
        iconAnchor: [40, 10],
      });
      const m = L.marker([midLat, midLng], { icon, interactive: false });
      (m as unknown as Record<string, unknown>)._isMeasureLabel = true;
      this.measureLayer.addLayer(m);
    }

    // Total distance label at the last point
    const last = this.measurePoints[this.measurePoints.length - 1];
    const totalLabel = this.formatDistance(totalDist);
    const totalIcon = L.divIcon({
      className: 'measure-total-icon',
      html: `<div class="measure-total-label" id="measure-finish">${totalLabel}<br><span class="measure-hint-small">click to finish</span></div>`,
      iconSize: [100, 40],
      iconAnchor: [50, -5],
    });
    const totalMarker = L.marker([last.lat, last.lng], { icon: totalIcon, interactive: true });
    (totalMarker as unknown as Record<string, unknown>)._isMeasureLabel = true;
    totalMarker.on('click', () => this.finishMeasure());
    this.measureLayer.addLayer(totalMarker);
  }

  private finishMeasure(): void {
    this.measuring = false;
    this.hideMeasureHint();
    // Leave the line and labels visible; they can be cleared by starting a new measurement
  }

  clearMeasure(): void {
    this.measuring = false;
    this.measurePoints = [];
    this.measureLine = null;
    this.measureLayer.clearLayers();
    this.hideMeasureHint();
  }

  private formatDistance(meters: number): string {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  }

  private showMeasureHint(text: string): void {
    let hint = document.getElementById('measure-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'measure-hint';
      document.getElementById('app')!.appendChild(hint);
    }
    hint.textContent = text;
    hint.classList.add('visible');
  }

  private hideMeasureHint(): void {
    const hint = document.getElementById('measure-hint');
    if (hint) hint.classList.remove('visible');
  }
}
