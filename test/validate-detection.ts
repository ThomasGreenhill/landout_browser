/**
 * Validation tests for landing strip detection.
 * Run with: npx tsx test/validate-detection.ts
 */

import { readFileSync } from 'fs';
import { parseDescriptionHints, computeStripFromEndpoints, buildRunwayRect } from '../src/field-detector';

let passed = 0, failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// --- Description parsing tests ---

console.log('\n=== Description Parsing ===');

{
  const h = parseDescriptionHints('16/34 33A unknown');
  assert(h.headings?.[0] === 160 && h.headings?.[1] === 340, '"16/34" → headings 160/340');
  assert(h.lengthFt === 3300, '"33A" → 3300ft');
  assert(h.lengthM === 1006, '"33A" → 1006m');
}

{
  const h = parseDescriptionHints('E/W 34D');
  assert(h.headings?.[0] === 90 && h.headings?.[1] === 270, '"E/W" → headings 90/270');
  assert(h.lengthFt === 3400, '"34D" → 3400ft');
}

{
  const h = parseDescriptionHints('N/S 24A');
  assert(h.headings?.[0] === 0 && h.headings?.[1] === 180, '"N/S" → headings 0/180');
  assert(h.lengthFt === 2400, '"24A" → 2400ft');
}

{
  const h = parseDescriptionHints('09/27 19D');
  assert(h.headings?.[0] === 90 && h.headings?.[1] === 270, '"09/27" → headings 90/270');
  assert(h.lengthFt === 1900, '"19D" → 1900ft');
}

{
  const h = parseDescriptionHints('7/25 41S');
  assert(h.headings?.[0] === 70 && h.headings?.[1] === 250, '"7/25" → headings 70/250');
  assert(h.lengthFt === 4100, '"41S" → 4100ft');
}

{
  const h = parseDescriptionHints('Land To East');
  assert(h.notes.some(n => n.includes('Land To East')), '"Land To East" → note captured');
}

{
  const h = parseDescriptionHints('Strip is unsafe. Land on Camatta Creek Rd.');
  assert(h.notes.some(n => n.includes('WARNING')), 'unsafe → WARNING note');
}

{
  const h = parseDescriptionHints('20m wide fence each side');
  assert(h.notes.some(n => n.includes('Fence')), 'fence → noted');
}

{
  const h = parseDescriptionHints('power lines on the West side');
  assert(h.notes.some(n => n.includes('Power lines')), 'power lines → noted');
}

{
  const h = parseDescriptionHints('Narrow');
  assert(h.notes.some(n => n.includes('Narrow')), 'narrow → noted');
}

// --- Strip geometry tests ---

console.log('\n=== Strip Geometry ===');

{
  // Two points roughly 1km apart east-west
  const s = computeStripFromEndpoints(36.0, -120.0, 36.0, -120.01, 30);
  assert(s.lengthM > 800 && s.lengthM < 1000, `E/W strip length ${s.lengthM}m (expect ~900m)`);
  assert(s.orientationDeg > 80 && s.orientationDeg < 100, `E/W orientation ${s.orientationDeg}° (expect ~90°)`);
}

{
  // Two points roughly N-S
  const s = computeStripFromEndpoints(36.0, -120.0, 36.009, -120.0, 30);
  assert(s.lengthM > 900 && s.lengthM < 1100, `N/S strip length ${s.lengthM}m (expect ~1000m)`);
  assert(s.orientationDeg < 10 || s.orientationDeg > 170, `N/S orientation ${s.orientationDeg}° (expect ~0° or ~180°)`);
}

// --- Runway rectangle tests ---

console.log('\n=== Runway Rectangles ===');

{
  // Center at (400, 400), north runway (0°), 500m long, 1.19 m/px
  const corners = buildRunwayRect(400, 400, 0, 500, 20, 1.19);
  assert(corners.length === 4, 'Rectangle has 4 corners');
  // Top corners should be above center, bottom below
  const topY = Math.min(...corners.map(c => c.y));
  const botY = Math.max(...corners.map(c => c.y));
  const expectedHalfLen = (500 / 2) / 1.19;
  assert(Math.abs((400 - topY) - expectedHalfLen) < 5, `Top offset ~${Math.round(expectedHalfLen)}px`);
  assert(Math.abs((botY - 400) - expectedHalfLen) < 5, `Bottom offset ~${Math.round(expectedHalfLen)}px`);
}

{
  // E/W runway (90°)
  const corners = buildRunwayRect(400, 400, 90, 800, 30, 1.19);
  const leftX = Math.min(...corners.map(c => c.x));
  const rightX = Math.max(...corners.map(c => c.x));
  const expectedHalfLen = (800 / 2) / 1.19;
  assert(Math.abs((rightX - leftX) / 2 - expectedHalfLen) < 10, `E/W runway extends ~${Math.round(expectedHalfLen)}px each side`);
}

// --- .cup file airfield validation ---

console.log('\n=== Cup File Airfields ===');

try {
  const cupText = readFileSync('/home/thomas/Downloads/Avenal_Contest_25.cup', 'utf-8');
  const lines = cupText.split('\n').slice(1).filter(l => l.trim());
  let airfieldCount = 0;
  let withRunway = 0;

  for (const line of lines) {
    // Simple CSV parse (handles quoted fields minimally)
    const fields = line.split(',');
    if (fields.length < 10) continue;
    const style = parseInt(fields[6] || '0', 10);
    if (style !== 2 && style !== 5) continue;
    airfieldCount++;

    const rwdir = parseInt(fields[7] || '0', 10);
    const rwlenStr = (fields[8] || '').replace(/[^0-9.]/g, '');
    const rwlen = parseFloat(rwlenStr) || 0;

    if (rwdir > 0 && rwlen > 0) {
      withRunway++;
      // Verify rectangle can be built
      const corners = buildRunwayRect(400, 400, rwdir, rwlen, 0, 1.19);
      assert(corners.length === 4, `${fields[0]}: rect has 4 corners (rwy ${rwdir}°/${rwlen}m)`);
    }
  }

  console.log(`  Checked ${airfieldCount} airfields, ${withRunway} with runway data`);
  assert(withRunway > 100, `At least 100 airfields have runway data (got ${withRunway})`);
} catch (e) {
  console.log('  SKIP: Could not load cup file');
}

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
