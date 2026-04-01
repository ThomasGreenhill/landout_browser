const TILE_SIZE = 256;
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * Meters per pixel at a given latitude and zoom level.
 */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

function fetchTile(z: number, y: number, x: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile ${z}/${y}/${x}`));
    img.src = `${TILE_URL}/${z}/${y}/${x}`;
  });
}

export interface CompositeResult {
  dataUrl: string;
  /** The full-resolution canvas (before downscale) for CV analysis */
  canvas: HTMLCanvasElement;
  metersPerPx: number;
  totalWidthM: number;
  /** Waypoint pixel position in the full-res canvas */
  waypointPixel: { x: number; y: number };
  /** Convert pixel coordinates in the full-res canvas to lat/lon */
  pixelToLatLon: (px: number, py: number) => { lat: number; lon: number };
}

/**
 * Fetch a grid of satellite tiles centered on a coordinate and composite them
 * into a single JPEG image. Draws a red crosshair at the exact waypoint location.
 */
export async function compositeTiles(
  lat: number,
  lon: number,
  zoom = 17,
  gridSize = 5,
): Promise<CompositeResult> {
  const center = latLonToTile(lat, lon, zoom);
  const half = Math.floor(gridSize / 2);
  const mpp = metersPerPixel(lat, zoom);
  const canvasSize = gridSize * TILE_SIZE;

  // Build tile coordinate list
  const tileCoords: Array<{ x: number; y: number; gx: number; gy: number }> = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      tileCoords.push({
        x: center.x + dx,
        y: center.y + dy,
        gx: (dx + half) * TILE_SIZE,
        gy: (dy + half) * TILE_SIZE,
      });
    }
  }

  // Fetch all tiles in parallel
  const results = await Promise.allSettled(
    tileCoords.map((t) => fetchTile(zoom, t.y, t.x)),
  );

  // Composite onto canvas
  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const ctx = canvas.getContext('2d')!;

  // Dark background for failed tiles
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      ctx.drawImage(result.value, tileCoords[i].gx, tileCoords[i].gy);
    }
  });

  // Calculate waypoint pixel position in the canvas
  const n = Math.pow(2, zoom);
  const wpPixelX = (((lon + 180) / 360) * n - (center.x - half)) * TILE_SIZE;
  const latRad = (lat * Math.PI) / 180;
  const wpPixelY =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n -
      (center.y - half)) *
    TILE_SIZE;

  // NOTE: crosshair is drawn only on the downscaled display image, NOT on
  // the full-res canvas — so CV field detection works on clean satellite pixels

  // Downscale to 640x640 for AI display image, with crosshair
  const outSize = 640;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outSize;
  outCanvas.height = outSize;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.drawImage(canvas, 0, 0, canvasSize, canvasSize, 0, 0, outSize, outSize);

  // Draw crosshair on display image only
  const scale = outSize / canvasSize;
  outCtx.strokeStyle = '#ef4444';
  outCtx.lineWidth = 2;
  const crossSize = 12;
  const sx = wpPixelX * scale, sy = wpPixelY * scale;
  outCtx.beginPath(); outCtx.moveTo(sx - crossSize, sy); outCtx.lineTo(sx + crossSize, sy); outCtx.stroke();
  outCtx.beginPath(); outCtx.moveTo(sx, sy - crossSize); outCtx.lineTo(sx, sy + crossSize); outCtx.stroke();
  outCtx.beginPath(); outCtx.arc(sx, sy, crossSize * 0.6, 0, Math.PI * 2); outCtx.stroke();

  let dataUrl: string;
  try {
    dataUrl = outCanvas.toDataURL('image/jpeg', 0.8);
  } catch {
    throw new Error(
      'Cannot access satellite tiles due to browser security restrictions (CORS). ' +
      'Try using a different browser or disabling strict cross-origin policies.',
    );
  }

  // Build pixel-to-latlng converter
  // The canvas origin in tile-space is (center.x - half, center.y - half)
  const originTileX = center.x - half;
  const originTileY = center.y - half;

  // AI sees the downscaled image (outSize px), so scale pixel coords back to full canvas
  const scaleFactor = canvasSize / outSize;

  function pixelToLatLon(px: number, py: number): { lat: number; lon: number } {
    // Scale from downscaled image coords to full tile coords
    const fullPx = px * scaleFactor;
    const fullPy = py * scaleFactor;
    const tileX = originTileX + fullPx / TILE_SIZE;
    const tileY = originTileY + fullPy / TILE_SIZE;
    // Convert tile coordinates back to lat/lon
    const pLon = (tileX / n) * 360 - 180;
    const pLatRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
    const pLat = (pLatRad * 180) / Math.PI;
    return { lat: pLat, lon: pLon };
  }

  return {
    dataUrl,
    canvas,
    metersPerPx: mpp,
    totalWidthM: canvasSize * mpp,
    waypointPixel: { x: wpPixelX, y: wpPixelY },
    pixelToLatLon,
  };
}
