// End-to-end check of the payload with Google and TomTom stubbed out.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { buildCommute, readConfig, stripRoad, verifyMap } from '../lib/commute.js';
import { encodePolyline } from '../lib/geo.js';
import mapHandler from '../api/map.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const line = Array.from({ length: 21 }, (_, i) => [47.6, -122.3 + i * 0.005]);
const detour = [[47.6, -122.3], [47.62, -122.25], [47.6, -122.2]];

function route(points, durationSec, staticSec, description, steps) {
  const latLng = ([latitude, longitude]) => ({ latLng: { latitude, longitude } });
  return {
    duration: `${durationSec}s`,
    staticDuration: `${staticSec}s`,
    distanceMeters: 7500,
    description,
    polyline: { encodedPolyline: encodePolyline(points) },
    legs: [{ startLocation: latLng(points[0]), endLocation: latLng(points.at(-1)), steps }],
  };
}

const googleResponse = {
  routes: [
    route(detour, 1500, 1100, 'Detour Rd', [
      { distanceMeters: 9000, navigationInstruction: { instructions: 'Head north on Detour Rd' } },
    ]),
    route(line, 1320, 900, 'I-90 E', [
      { distanceMeters: 1000, navigationInstruction: { instructions: 'Head east on Pine St toward 1st Ave' } },
      { distanceMeters: 7000, navigationInstruction: { instructions: 'Merge onto I-90 E' } },
    ]),
  ],
};

const tomtomResponse = {
  incidents: [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-122.26, 47.6001], [-122.255, 47.6001], [-122.25, 47.6001]] },
      properties: {
        id: 'crash-1', iconCategory: 1, magnitudeOfDelay: 3, delay: 420,
        events: [{ description: 'Accident', code: 401 }], from: 'Rainier Ave', to: 'Mercer Island', roadNumbers: ['I-90'],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-122.25, 47.6002], [-122.26, 47.6002]] },
      properties: { id: 'other-way', iconCategory: 1, delay: 600 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.22, 47.6] },
      properties: { id: 'minor-jam', iconCategory: 6, magnitudeOfDelay: 1, delay: 20 },
    },
  ],
};

function stubFetch(calls) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://routes.googleapis.com')) return Response.json(googleResponse);
    if (String(url).startsWith('https://api.tomtom.com')) return Response.json(tomtomResponse);
    if (String(url).startsWith('https://maps.googleapis.com/maps/api/staticmap')) {
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const config = readConfig({
  GOOGLE_API_KEY: 'g-key',
  TOMTOM_API_KEY: 't-key',
  HOME_ADDRESS: '1 Home St',
  WORK_ADDRESS: '2 Work Ave',
  TIMEZONE: 'America/Los_Angeles',
  REVERSE_AFTER_HOUR: '12',
});

test('payload picks the fastest route and lists incidents on it', async () => {
  const calls = [];
  stubFetch(calls);
  const now = new Date('2026-09-24T15:00:00Z'); // 8:00 AM Pacific
  const result = await buildCommute(config, { now, baseUrl: 'https://example.test' });

  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.routingPreference, 'TRAFFIC_AWARE_OPTIMAL');
  assert.equal(request.computeAlternativeRoutes, true);
  assert.equal(request.origin.address, '1 Home St');
  assert.match(calls[0].init.headers['X-Goog-FieldMask'], /routes\.legs\.steps\.navigationInstruction/);

  assert.equal(result.direction, 'work');
  assert.equal(result.time, '22 min');
  assert.equal(result.via, 'I-90 E');
  assert.equal(result.delay_min, 7);
  assert.equal(result.traffic, 'heavy');
  assert.equal(result.arrive_by, '8:22 AM');
  assert.equal(result.updated_at, '8:00 AM');
  assert.equal(result.route_summary, 'Pine St → I-90 E');
  assert.equal(result.alternative_summary, '3 min faster than Detour Rd');

  assert.equal(result.incident_count, 1, 'opposite-direction crash and minor jam are filtered');
  assert.equal(result.accident_count, 1);
  assert.deepEqual(
    { ...result.incidents[0], miles_ahead: undefined, ahead: undefined, percent_along: undefined },
    {
      number: 1, type: 'Accident', is_accident: true, detail: '', road: 'I-90',
      where: 'Rainier Ave → Mercer Island', delay_min: 7, delay: '+7 min',
      miles_ahead: undefined, ahead: undefined, percent_along: undefined,
    },
  );
  assert.equal(result.headline, 'Heavy traffic, +7 min · 1 accident on route');

  const mapUrl = new URL(result.map_url);
  assert.equal(mapUrl.origin + mapUrl.pathname, 'https://example.test/map');
  assert.ok(!result.map_url.includes('g-key'), 'API key must not leak into the markup');
  assert.ok(verifyMap(mapUrl.searchParams.get('d'), mapUrl.searchParams.get('s'), config.signingSecret));
});

test('afternoon flips to the trip home', async () => {
  const calls = [];
  stubFetch(calls);
  const result = await buildCommute(config, { now: new Date('2026-09-25T00:30:00Z') }); // 5:30 PM
  assert.equal(result.direction, 'home');
  assert.equal(result.title, 'Work → Home');
  assert.equal(JSON.parse(calls[0].init.body).origin.address, '2 Work Ave');
});

test('map endpoint rejects tampered URLs and proxies valid ones', async () => {
  const calls = [];
  stubFetch(calls);
  process.env.GOOGLE_API_KEY = 'g-key';
  const result = await buildCommute(config, { baseUrl: 'https://example.test' });
  const url = new URL(result.map_url);

  const invoke = async (path) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
    await mapHandler({ url: path, headers: { host: 'example.test' } }, res);
    return res;
  };

  const ok = await invoke(`${url.pathname}${url.search}&w=380&h=420`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Content-Type'], 'image/png');
  const staticCall = new URL(calls.at(-1).url);
  assert.equal(staticCall.searchParams.get('size'), '380x420');
  assert.equal(staticCall.searchParams.getAll('markers').length, 3, 'A, B and one incident');
  assert.equal(staticCall.searchParams.getAll('path').length, 2, 'slowdown halo + route');

  const bad = await invoke(`${url.pathname}${url.search.replace(/s=[^&]+/, 's=forged')}`);
  assert.equal(bad.statusCode, 403);
  delete process.env.GOOGLE_API_KEY;
});

test('repeated road numbers are dropped from incident locations', () => {
  assert.equal(stripRoad('Bridge Way/Fremont Way (WA-99)', 'WA-99'), 'Bridge Way/Fremont Way');
  assert.equal(stripRoad('6th Ave/Broad St (WA-99)', 'WA-99'), '6th Ave/Broad St');
  assert.equal(stripRoad('Mercer St (I-5)', 'WA-99'), 'Mercer St (I-5)', 'other roads are kept');
  assert.equal(stripRoad('Rainier Ave', ''), 'Rainier Ave');
});
