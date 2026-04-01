import L from 'leaflet';

export class MapManager {
  readonly map: L.Map;
  readonly waypointLayer = L.layerGroup();
  readonly homeMarkerLayer = L.layerGroup();

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

    L.control.layers(
      { 'Satellite': satellite },
      { 'Place names': labels },
    ).addTo(this.map);
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
}
