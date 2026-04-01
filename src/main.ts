import './style.css';
import { MapManager } from './map-manager';
import { UIController } from './ui-controller';

const mapManager = new MapManager('map');
new UIController(mapManager);
