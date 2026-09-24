// Geometry helpers: Google encoded polylines, distances, and projecting a
// point onto a route so we know how far along the drive it sits.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

export function encodePolyline(points) {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return chunk + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeValue(iLat - prevLat) + encodeValue(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

export function haversine([lat1, lng1], [lat2, lng2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Local flat projection (metres) around a reference latitude. Accurate enough
// for the sub-kilometre distances we compare here.
function project([lat, lng], refLat) {
  const x = toRad(lng) * EARTH_RADIUS_M * Math.cos(toRad(refLat));
  const y = toRad(lat) * EARTH_RADIUS_M;
  return [x, y];
}

// Precompute cumulative distance so projections can report distance along.
export function buildRoute(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversine(points[i - 1], points[i]));
  }
  return {
    points,
    cumulative,
    length: cumulative[cumulative.length - 1] || 0,
    bbox: bboxOf(points),
  };
}

// Nearest point on the route to `point`: distance off-route and distance along.
export function projectOntoRoute(route, point) {
  const { points, cumulative } = route;
  const refLat = point[0];
  const [px, py] = project(point, refLat);
  let best = { offset: Infinity, along: 0 };
  if (points.length === 1) {
    return { offset: haversine(points[0], point), along: 0 };
  }
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = project(points[i], refLat);
    const [bx, by] = project(points[i + 1], refLat);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const offset = Math.hypot(px - cx, py - cy);
    if (offset < best.offset) {
      best = { offset, along: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]) };
    }
  }
  return best;
}

// Douglas-Peucker simplification with a tolerance in metres. Keeps map URLs short.
export function simplify(points, toleranceM) {
  if (points.length < 3) return points.slice();
  const refLat = points[0][0];
  const xy = points.map((p) => project(p, refLat));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const [ax, ay] = xy[start];
    const [bx, by] = xy[end];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = xy[i];
      const dist = len
        ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
        : Math.hypot(px - ax, py - ay);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceM && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Approximate area of a lat/lng box in km².
export function bboxAreaKm2({ minLat, maxLat, minLng, maxLng }) {
  const height = haversine([minLat, minLng], [maxLat, minLng]) / 1000;
  const midLat = (minLat + maxLat) / 2;
  const width = haversine([midLat, minLng], [midLat, maxLng]) / 1000;
  return height * width;
}

// Grow a box by `metres` on every side.
export function padBbox({ minLat, maxLat, minLng, maxLng }, metres) {
  const dLat = toDeg(metres / EARTH_RADIUS_M);
  const midLat = (minLat + maxLat) / 2;
  const dLng = dLat / Math.max(Math.cos(toRad(midLat)), 0.01);
  return {
    minLat: minLat - dLat,
    maxLat: maxLat + dLat,
    minLng: minLng - dLng,
    maxLng: maxLng + dLng,
  };
}

export function bboxOf(points) {
  const box = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
  for (const [lat, lng] of points) {
    box.minLat = Math.min(box.minLat, lat);
    box.maxLat = Math.max(box.maxLat, lat);
    box.minLng = Math.min(box.minLng, lng);
    box.maxLng = Math.max(box.maxLng, lng);
  }
  return box;
}
