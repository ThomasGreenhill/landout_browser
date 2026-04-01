# Landout Browser

Interactive satellite map browser for gliding landout sites from SeeYou `.cup` files.

## Features

- Load any `.cup` waypoint file via drag-and-drop or file picker
- Satellite imagery map (Esri World Imagery) with place-name overlay
- Color-coded markers by waypoint type (gliding airfield, paved, grass, outlanding)
- Select a home point to see distance and bearing to every landout site
- Filter waypoints by type and maximum distance from home
- Detailed popups with elevation, runway info, frequency, and description

## Getting Started

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The production build outputs to `dist/` and can be deployed to any static hosting service.

## CUP File Format

The app accepts standard SeeYou `.cup` files — a CSV format widely used in gliding for waypoint exchange. Most gliding clubs and competition organizers publish their waypoints in this format.
