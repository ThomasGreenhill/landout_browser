import './style.css';
import { MapManager } from './map-manager';

const mapManager = new MapManager('map');

// Expose for later wiring
(window as unknown as Record<string, unknown>).__mapManager = mapManager;
