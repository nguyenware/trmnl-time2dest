import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoute, decodePolyline, encodePolyline, projectOntoRoute, simplify } from '../lib/geo.js';
import { mainRoads, roadFromInstruction, trafficLevel } from '../lib/summary.js';
import { matchIncidents } from '../lib/tomtom.js';

test('polyline round-trips (Google reference example)', () => {
  const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const points = decodePolyline(encoded);
  assert.deepEqual(points, [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
  assert.equal(encodePolyline(points), encoded);
});

// A straight road heading due east, ~1.1 km long.
const eastbound = buildRoute(Array.from({ length: 11 }, (_, i) => [47.6, -122.2 + i * 0.0015]));

test('projection reports offset and distance along', () => {
  const hit = projectOntoRoute(eastbound, [47.6003, -122.1925]); // ~33 m north, halfway
  assert.ok(hit.offset > 25 && hit.offset < 40, `offset ${hit.offset}`);
  assert.ok(Math.abs(hit.along - eastbound.length / 2) < 10, `along ${hit.along}`);
});

test('simplify keeps endpoints and drops collinear points', () => {
  const simple = simplify(eastbound.points, 5);
  assert.equal(simple.length, 2);
});

const lineIncident = (coords, props = {}) => ({
  geometry: { type: 'LineString', coordinates: coords.map(([lat, lng]) => [lng, lat]) },
  properties: { id: Math.random().toString(36), iconCategory: 1, delay: 300, ...props },
});

test('incidents on our side and direction of travel are kept', () => {
  const sameWay = lineIncident([
    [47.6001, -122.197],
    [47.6001, -122.195],
    [47.6001, -122.193],
  ]);
  const [match] = matchIncidents(eastbound, [sameWay]);
  assert.equal(match.type, 'Accident');
  assert.ok(match.alongM > 200 && match.alongM < 300);
});

test('opposite-direction and off-route incidents are ignored', () => {
  const oppositeWay = lineIncident([
    [47.6002, -122.193],
    [47.6002, -122.195],
    [47.6002, -122.197],
  ]);
  const parallelRoad = lineIncident([
    [47.602, -122.197],
    [47.602, -122.193],
  ]);
  const crossStreet = lineIncident([
    [47.598, -122.195],
    [47.6, -122.195],
    [47.602, -122.195],
  ]);
  assert.deepEqual(matchIncidents(eastbound, [oppositeWay, parallelRoad, crossStreet]), []);
});

test('point incidents close to the route are kept', () => {
  const point = { geometry: { type: 'Point', coordinates: [-122.19, 47.6002] }, properties: { iconCategory: 14 } };
  assert.equal(matchIncidents(eastbound, [point])[0].type, 'Stalled vehicle');
});

test('road names are pulled out of Google instructions', () => {
  assert.equal(roadFromInstruction('Head north on Main St toward 2nd Ave'), 'Main St');
  assert.equal(roadFromInstruction('Merge onto I-405 S via exit 12 toward Renton'), 'I-405 S');
  assert.equal(roadFromInstruction('Keep left to continue on WA-520 W'), 'WA-520 W');
  assert.equal(roadFromInstruction('Turn right onto NE 8th St\nDestination will be on the right'), 'NE 8th St');
  assert.equal(roadFromInstruction('Take exit 13A on the right for NE 4th St'), 'NE 4th St');
  assert.equal(roadFromInstruction('Turn left'), '');
});

test('main roads keep the long legs in driving order', () => {
  const steps = [
    { distanceM: 400, instruction: 'Head east on Oak Ave toward 3rd St' },
    { distanceM: 300, instruction: 'Turn left onto 3rd St' },
    { distanceM: 800, instruction: 'Turn right to merge onto I-5 N', maneuver: 'RAMP_RIGHT' },
    { distanceM: 12000, instruction: 'Merge onto I-5 N' },
    { distanceM: 500, instruction: 'Take exit 168B for WA-520 E', maneuver: 'RAMP_RIGHT' },
    { distanceM: 6000, instruction: 'Merge onto WA-520 E' },
    { distanceM: 2400, instruction: 'Turn right onto 148th Ave NE' },
    { distanceM: 150, instruction: 'Turn left onto Office Park Dr' },
  ];
  assert.deepEqual(mainRoads(steps), ['I-5 N', 'WA-520 E', '148th Ave NE']);
});

test('traffic level buckets', () => {
  assert.equal(trafficLevel(1260, 1200), 'light');
  assert.equal(trafficLevel(1500, 1200), 'moderate');
  assert.equal(trafficLevel(2400, 1200), 'heavy');
});
