// Google Maps Platform: Routes API (computeRoutes) and Static Maps.
// Replaces the legacy Directions API, which Google no longer enables on new
// projects.

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap';

const FIELD_MASK = [
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.description',
  'routes.warnings',
  'routes.routeLabels',
  'routes.polyline.encodedPolyline',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.navigationInstruction',
].join(',');

export class UpstreamError extends Error {
  constructor(service, status, detail) {
    super(`${service} returned ${status}: ${detail}`);
    this.service = service;
    this.status = status;
  }
}

const seconds = (duration) => Number.parseFloat(duration ?? '0') || 0;

async function callRoutes(apiKey, body) {
  const response = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(9000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new UpstreamError('Routes API', response.status, data?.error?.message ?? response.statusText);
  }
  return data;
}

// Ask for every traffic-aware alternative Google has, then keep the one with the
// shortest live duration. TRAFFIC_AWARE_OPTIMAL is the same exhaustive search the
// Google Maps app uses.
export async function computeRoutes({ apiKey, origin, destination, avoidTolls, avoidHighways }) {
  const body = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    computeAlternativeRoutes: true,
    polylineQuality: 'OVERVIEW',
    languageCode: 'en-US',
    units: 'IMPERIAL',
    routeModifiers: { avoidTolls, avoidHighways },
  };

  let data;
  try {
    data = await callRoutes(apiKey, body);
  } catch (err) {
    // The optimal search can occasionally time out on long trips; the faster
    // traffic-aware mode is a close second rather than showing nothing.
    if (!(err instanceof UpstreamError) || err.status < 500) throw err;
    data = await callRoutes(apiKey, { ...body, routingPreference: 'TRAFFIC_AWARE' });
  }

  const routes = (data.routes ?? [])
    .filter((route) => route.polyline?.encodedPolyline && route.legs?.length)
    .map((route) => ({
      durationSec: seconds(route.duration),
      staticDurationSec: seconds(route.staticDuration),
      distanceM: route.distanceMeters ?? 0,
      description: route.description ?? '',
      warnings: route.warnings ?? [],
      labels: route.routeLabels ?? [],
      polyline: route.polyline.encodedPolyline,
      start: toLatLng(route.legs[0].startLocation),
      end: toLatLng(route.legs[route.legs.length - 1].endLocation),
      steps: route.legs.flatMap((leg) => leg.steps ?? []).map((step) => ({
        distanceM: step.distanceMeters ?? 0,
        instruction: step.navigationInstruction?.instructions ?? '',
        maneuver: step.navigationInstruction?.maneuver ?? '',
      })),
    }))
    .sort((a, b) => a.durationSec - b.durationSec);

  return routes;
}

function toLatLng(location) {
  const { latitude, longitude } = location?.latLng ?? {};
  return [latitude, longitude];
}

// Static map tuned for e-ink: white land, grey roads, no POIs or transit, and
// every colour we draw is a shade of grey so dithering stays crisp.
const EINK_STYLE = [
  'feature:all|element:geometry|saturation:-100',
  'feature:all|element:labels.text.fill|color:0x000000',
  'feature:all|element:labels.text.stroke|color:0xffffff|weight:3',
  'feature:all|element:labels.icon|visibility:off',
  'feature:landscape|element:geometry|color:0xffffff',
  'feature:poi|visibility:off',
  'feature:transit|visibility:off',
  'feature:administrative|element:geometry|visibility:off',
  'feature:water|element:geometry|color:0xd0d0d0',
  'feature:road|element:geometry.stroke|visibility:off',
  'feature:road.local|element:geometry|color:0xe6e6e6',
  'feature:road.local|element:labels|visibility:off',
  'feature:road.arterial|element:geometry|color:0xcfcfcf',
  'feature:road.highway|element:geometry|color:0xa8a8a8',
];

// `map` is the compact description produced by commute.js and carried in the
// signed /map URL, so the proxy never has to recompute the route.
export function buildStaticMapUrl({ apiKey, map, width, height }) {
  const params = new URLSearchParams();
  params.set('size', `${width}x${height}`);
  params.set('scale', '2');
  params.set('format', 'png');
  for (const style of EINK_STYLE) params.append('style', style);

  // Congestion first so the route line draws on top of it as a grey halo.
  for (const jam of map.jams ?? []) {
    params.append('path', `color:0x00000070|weight:14|enc:${jam}`);
  }
  params.append('path', `color:0x000000ff|weight:5|enc:${map.route}`);

  const [start, end] = [map.start, map.end].map(([lat, lng]) => `${lat},${lng}`);
  params.append('markers', `size:mid|color:0xffffff|label:A|${start}`);
  params.append('markers', `size:mid|color:0xffffff|label:B|${end}`);
  (map.incidents ?? []).forEach(([lat, lng], i) => {
    params.append('markers', `size:mid|color:0x000000|label:${i + 1}|${lat},${lng}`);
  });

  params.set('key', apiKey);
  return `${STATIC_MAP_URL}?${params}`;
}
