// Turn Google's turn-by-turn steps into a one-glance "gist" of the drive:
// the handful of roads you spend most of the trip on, in order.

const ROAD_PATTERNS = [
  /\b(?:onto|on|to stay on|to continue on|continue on)\s+(.+)$/i,
  /\bfor\s+(.+)$/i, // "take exit 12 for NE 8th St"
];

// Cut trailing clauses that aren't part of the road name.
const TRAILING = /\s+(?:toward|towards|heading|and|then|via|pass(?:ing)?|at the)\b.*$|\s*[(,.].*$/i;

export function roadFromInstruction(instruction) {
  const firstLine = (instruction ?? '').split('\n')[0].trim();
  if (!firstLine) return '';
  for (const pattern of ROAD_PATTERNS) {
    const match = firstLine.match(pattern);
    if (match) {
      const road = match[1].replace(TRAILING, '').trim();
      if (road && !/^(the )?(left|right|ramp|exit)\b/i.test(road)) return road;
    }
  }
  return '';
}

// Exit ramps are brief but their instruction names the road they lead to; the
// ramp's own distance shouldn't make that road look like a major leg.
const isRamp = (step) => /RAMP|FORK/.test(step.maneuver) || /\bexit\b|\bramp\b/i.test(step.instruction);

export function mainRoads(steps, { maxRoads = 4, minShare = 0.08 } = {}) {
  const legs = [];
  let current = null;
  for (const step of steps) {
    const road = roadFromInstruction(step.instruction);
    if (road && !(isRamp(step) && step.distanceM < 1500)) {
      if (!current || current.road !== road) {
        current = { road, distanceM: 0 };
        legs.push(current);
      }
    }
    if (current) current.distanceM += step.distanceM;
  }

  const total = legs.reduce((sum, leg) => sum + leg.distanceM, 0) || 1;
  // A road can appear more than once (e.g. stay on I-5 through an interchange).
  const byRoad = new Map();
  for (const leg of legs) byRoad.set(leg.road, (byRoad.get(leg.road) ?? 0) + leg.distanceM);

  const keep = new Set(
    [...byRoad.entries()]
      .filter(([, distance]) => distance / total >= minShare)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxRoads)
      .map(([road]) => road),
  );

  const ordered = [];
  for (const leg of legs) {
    if (keep.has(leg.road) && ordered[ordered.length - 1] !== leg.road && !ordered.includes(leg.road)) {
      ordered.push(leg.road);
    }
  }
  return ordered;
}

export const minutes = (sec) => Math.max(0, Math.round(sec / 60));

export function formatDuration(sec) {
  const total = minutes(sec);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export const miles = (m) => m / 1609.344;

export function formatMiles(m) {
  const mi = miles(m);
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

export function formatClock(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
}

// Traffic delay compared with the same route in free-flowing traffic.
export function trafficLevel(durationSec, staticDurationSec) {
  const delay = durationSec - staticDurationSec;
  const ratio = staticDurationSec ? durationSec / staticDurationSec : 1;
  if (delay < 120 || ratio < 1.1) return 'light';
  if (ratio < 1.3) return 'moderate';
  return 'heavy';
}
