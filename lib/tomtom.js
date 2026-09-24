// TomTom Traffic Incident Details v5: accidents, closures, jams, roadworks.
// Google's Routes API folds traffic into the ETA but doesn't say *why*, so
// incidents come from TomTom and are matched to the chosen route here.

import { bboxAreaKm2, bboxOf, padBbox, projectOntoRoute } from './geo.js';

const INCIDENTS_URL = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,' +
  'events{description,code,iconCategory},startTime,from,to,length,delay,roadNumbers}}}';
const MAX_BBOX_KM2 = 9000; // TomTom rejects boxes over 10,000 km²

export const CATEGORIES = {
  0: 'Incident',
  1: 'Accident',
  2: 'Fog',
  3: 'Hazard',
  4: 'Rain',
  5: 'Ice',
  6: 'Traffic jam',
  7: 'Lane closed',
  8: 'Road closed',
  9: 'Roadwork',
  10: 'Wind',
  11: 'Flooding',
  14: 'Stalled vehicle',
};

// Lower sorts first when we have to trim the list for the display.
const PRIORITY = { 1: 0, 8: 1, 14: 2, 3: 3, 11: 3, 5: 3, 6: 4, 7: 5, 9: 6 };

// How far from the route line an incident may sit and still be "on" it.
// Tight enough to reject parallel frontage roads, loose enough for GPS jitter.
const LINE_TOLERANCE_M = 45;
const POINT_TOLERANCE_M = 60;

// Break the route into boxes TomTom will accept.
function routeBoxes(points) {
  const box = padBbox(bboxOf(points), 500);
  if (bboxAreaKm2(box) <= MAX_BBOX_KM2 || points.length < 4) return [box];
  const mid = Math.floor(points.length / 2);
  return [...routeBoxes(points.slice(0, mid + 1)), ...routeBoxes(points.slice(mid))];
}

async function fetchBox(apiKey, box) {
  const params = new URLSearchParams({
    key: apiKey,
    bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat].map((n) => n.toFixed(5)).join(','),
    fields: FIELDS,
    language: 'en-US',
    timeValidityFilter: 'present',
  });
  const response = await fetch(`${INCIDENTS_URL}?${params}`, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`TomTom returned ${response.status}: ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.incidents ?? [];
}

export async function fetchIncidents(apiKey, points) {
  const batches = await Promise.all(routeBoxes(points).map((box) => fetchBox(apiKey, box)));
  const byId = new Map();
  for (const incident of batches.flat()) byId.set(incident.properties?.id ?? byId.size, incident);
  return [...byId.values()];
}

// Keep incidents that sit on the route *in our direction of travel*. A crash on
// the opposite carriageway of a freeway is ~30 m away, so distance alone isn't
// enough: a line incident must also run forwards along the route.
export function matchIncidents(route, incidents) {
  const matched = [];
  for (const incident of incidents) {
    const { type, coordinates } = incident.geometry ?? {};
    if (!coordinates) continue;
    const coords = type === 'Point' ? [coordinates] : coordinates;
    const points = coords.map(([lng, lat]) => [lat, lng]);

    let along;
    let onRoute = points;
    if (points.length === 1) {
      const hit = projectOntoRoute(route, points[0]);
      if (hit.offset > POINT_TOLERANCE_M) continue;
      along = hit.along;
    } else {
      const hits = points.map((p) => ({ p, ...projectOntoRoute(route, p) }));
      const near = hits.filter((h) => h.offset <= LINE_TOLERANCE_M);
      // Need a real overlap, not a cross street touching the route once.
      if (near.length < 2 || near.length < hits.length * 0.3) continue;
      const first = near[0];
      const last = near[near.length - 1];
      if (last.along - first.along < 20) continue; // wrong direction or no overlap
      along = first.along;
      onRoute = near.map((h) => h.p);
    }
    matched.push(describe(incident, along, onRoute));
  }
  return matched.sort((a, b) => a.alongM - b.alongM);
}

function describe(incident, alongM, onRoute) {
  const props = incident.properties ?? {};
  const category = props.iconCategory ?? 0;
  const event = props.events?.[0]?.description ?? '';
  const road = (props.roadNumbers ?? [])[0] ?? '';
  const mid = onRoute[Math.floor(onRoute.length / 2)];
  return {
    id: props.id,
    category,
    type: CATEGORIES[category] ?? 'Incident',
    event,
    road,
    from: props.from ?? '',
    to: props.to ?? '',
    delaySec: props.delay ?? 0,
    magnitude: props.magnitudeOfDelay ?? 0,
    lengthM: props.length ?? 0,
    alongM,
    point: mid,
    line: onRoute.length > 1 ? onRoute : null,
  };
}

// Anything worth putting on a small screen: every accident/closure/hazard, and
// jams or lane closures only when they actually cost time.
export function isNotable(incident) {
  if ([6, 7, 9].includes(incident.category)) {
    return incident.delaySec >= 60 || incident.magnitude >= 2;
  }
  return true;
}

export function byPriority(a, b) {
  return (PRIORITY[a.category] ?? 7) - (PRIORITY[b.category] ?? 7) || b.delaySec - a.delaySec;
}
