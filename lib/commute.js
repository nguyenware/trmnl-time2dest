// Builds the JSON payload TRMNL polls: fastest route, drive time, a gist of the
// route, incidents along it, and a signed URL for the e-ink map.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { buildRoute, decodePolyline, encodePolyline, simplify } from './geo.js';
import { computeRoutes } from './google.js';
import { byPriority, fetchIncidents, isNotable, matchIncidents } from './tomtom.js';
import {
  formatClock,
  formatDuration,
  formatMiles,
  mainRoads,
  miles,
  minutes,
  trafficLevel,
} from './summary.js';

const MAX_INCIDENTS = 6;

export function readConfig(env = process.env) {
  const flag = (name) => /^(1|true|yes)$/i.test(env[name] ?? '');
  return {
    googleKey: env.GOOGLE_API_KEY,
    tomtomKey: env.TOMTOM_API_KEY,
    home: env.HOME_ADDRESS,
    work: env.WORK_ADDRESS,
    homeLabel: env.HOME_LABEL || 'Home',
    workLabel: env.WORK_LABEL || 'Work',
    timeZone: env.TIMEZONE || 'America/Los_Angeles',
    reverseAfterHour: env.REVERSE_AFTER_HOUR ? Number(env.REVERSE_AFTER_HOUR) : null,
    avoidTolls: flag('AVOID_TOLLS'),
    avoidHighways: flag('AVOID_HIGHWAYS'),
    signingSecret: env.MAP_SIGNING_SECRET || env.GOOGLE_API_KEY || '',
  };
}

export function missingConfig(config) {
  return [
    ['GOOGLE_API_KEY', config.googleKey],
    ['HOME_ADDRESS', config.home],
    ['WORK_ADDRESS', config.work],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function localHour(date, timeZone) {
  const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(date);
  return Number(hour);
}

// Morning: home → work. Optionally flip to work → home in the afternoon, or on
// demand with ?direction=home / ?direction=work.
export function chooseDirection(config, now, requested) {
  if (requested === 'home') return 'home';
  if (requested === 'work') return 'work';
  if (config.reverseAfterHour != null && localHour(now, config.timeZone) >= config.reverseAfterHour) {
    return 'home';
  }
  return 'work';
}

export function signMap(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 22);
}

export function verifyMap(payload, signature, secret) {
  const expected = Buffer.from(signMap(payload, secret));
  const given = Buffer.from(signature ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function mapPayload(route, incidents) {
  const round = ([lat, lng]) => [Number(lat.toFixed(5)), Number(lng.toFixed(5))];
  const jams = incidents
    .filter((incident) => incident.line && (incident.category === 6 || incident.delaySec >= 120))
    .map((incident) => encodePolyline(simplify(incident.line, 25)));
  return {
    route: encodePolyline(simplify(decodePolyline(route.polyline), 15)),
    start: round(route.start),
    end: round(route.end),
    jams,
    // Markers are numbered 1–9 to match the incident list on screen.
    incidents: incidents.slice(0, 9).map((incident) => round(incident.point)),
  };
}

function incidentView(incident, index, route) {
  const aheadMi = miles(incident.alongM);
  const where = incident.from && incident.to && incident.from !== incident.to
    ? `${incident.from} → ${incident.to}`
    : incident.from || incident.to;
  const delayMin = minutes(incident.delaySec);
  return {
    number: index + 1,
    type: incident.type,
    is_accident: incident.category === 1,
    detail: incident.event && incident.event.toLowerCase() !== incident.type.toLowerCase() ? incident.event : '',
    road: incident.road,
    where: where ?? '',
    delay_min: delayMin,
    delay: delayMin ? `+${delayMin} min` : '',
    miles_ahead: Number(aheadMi.toFixed(1)),
    ahead: aheadMi < 0.1 ? 'at start' : `in ${formatMiles(incident.alongM)}`,
    percent_along: Math.round((incident.alongM / (route.length || 1)) * 100),
  };
}

export async function buildCommute(config, { now = new Date(), direction: requested, baseUrl } = {}) {
  const direction = chooseDirection(config, now, requested);
  const [origin, destination] = direction === 'work' ? [config.home, config.work] : [config.work, config.home];
  const [originLabel, destinationLabel] =
    direction === 'work' ? [config.homeLabel, config.workLabel] : [config.workLabel, config.homeLabel];

  const routes = await computeRoutes({
    apiKey: config.googleKey,
    origin,
    destination,
    avoidTolls: config.avoidTolls,
    avoidHighways: config.avoidHighways,
  });
  if (!routes.length) {
    const error = new Error('No drivable route found between the two addresses');
    error.status = 404;
    throw error;
  }

  const best = routes[0];
  const geometry = buildRoute(decodePolyline(best.polyline));

  let incidents = [];
  let incidentsError = null;
  if (config.tomtomKey) {
    try {
      incidents = matchIncidents(geometry, await fetchIncidents(config.tomtomKey, geometry.points));
    } catch (err) {
      // Drive time still matters more than the incident list; show it anyway.
      incidentsError = err.message;
      console.error('Incident lookup failed:', err.message);
    }
  }

  const notable = incidents.filter(isNotable);
  // Show the most serious ones, then list them in the order you'll reach them.
  const shown = [...notable].sort(byPriority).slice(0, MAX_INCIDENTS).sort((a, b) => a.alongM - b.alongM);
  const accidents = notable.filter((incident) => incident.category === 1);
  const incidentDelaySec = notable.reduce((sum, incident) => sum + incident.delaySec, 0);

  const durationMin = minutes(best.durationSec);
  const delaySec = Math.max(0, best.durationSec - best.staticDurationSec);
  const roads = mainRoads(best.steps);
  const via = best.description || roads[0] || '';
  const arrival = new Date(now.getTime() + best.durationSec * 1000);

  const alternatives = routes.slice(1).map((alt) => ({
    via: alt.description || mainRoads(alt.steps)[0] || 'Alternate',
    minutes: minutes(alt.durationSec),
    extra_min: minutes(alt.durationSec - best.durationSec),
    distance: formatMiles(alt.distanceM),
  }));
  const nextBest = alternatives[0];

  const map = mapPayload(best, shown);
  const mapData = Buffer.from(JSON.stringify(map)).toString('base64url');
  const mapUrl = baseUrl
    ? `${baseUrl}/map?d=${mapData}&s=${signMap(mapData, config.signingSecret)}`
    : null;

  const level = trafficLevel(best.durationSec, best.staticDurationSec);
  const headline = [
    level === 'light' ? 'Traffic is light' : `${level[0].toUpperCase()}${level.slice(1)} traffic, +${minutes(delaySec)} min`,
    accidents.length ? `${accidents.length} accident${accidents.length > 1 ? 's' : ''} on route` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    // Kept for markup written against the original endpoint.
    time: formatDuration(best.durationSec),
    staticMapUrl: mapUrl,

    direction,
    origin_label: originLabel,
    destination_label: destinationLabel,
    title: `${originLabel} → ${destinationLabel}`,

    duration: formatDuration(best.durationSec),
    duration_min: durationMin,
    typical: formatDuration(best.staticDurationSec),
    typical_min: minutes(best.staticDurationSec),
    delay_min: minutes(delaySec),
    traffic: level,
    headline,
    distance: formatMiles(best.distanceM),
    distance_mi: Number(miles(best.distanceM).toFixed(1)),
    arrive_by: formatClock(arrival, config.timeZone),
    updated_at: formatClock(now, config.timeZone),
    updated_iso: now.toISOString(),

    via,
    roads,
    route_summary: roads.length ? roads.join(' → ') : via,
    warnings: best.warnings,

    route_count: routes.length,
    is_fastest: true,
    alternatives,
    alternative_summary: nextBest
      ? `${nextBest.extra_min ? `${nextBest.extra_min} min faster than` : 'Tied with'} ${nextBest.via}`
      : 'Only route available',

    incidents: shown.map((incident, i) => incidentView(incident, i, geometry)),
    incident_count: notable.length,
    accident_count: accidents.length,
    incident_delay_min: minutes(incidentDelaySec),
    incidents_enabled: Boolean(config.tomtomKey),
    incidents_error: incidentsError,

    map_url: mapUrl,
  };
}
