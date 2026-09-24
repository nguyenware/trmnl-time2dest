// Serves the route map image. The route geometry travels in the URL (signed,
// so nobody can use this endpoint to draw arbitrary maps on your API key) and
// the Google key never appears in the TRMNL markup.

import { verifyMap, readConfig } from '../lib/commute.js';
import { buildStaticMapUrl } from '../lib/google.js';
import { requestUrl, sendJson } from '../lib/http.js';

const clamp = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(640, Math.max(100, n)) : fallback;
};

export default async function handler(req, res) {
  const config = readConfig();
  if (!config.googleKey) return sendJson(res, 500, { error: 'GOOGLE_API_KEY is missing' });

  const url = requestUrl(req);
  const data = url.searchParams.get('d') ?? '';
  if (!verifyMap(data, url.searchParams.get('s'), config.signingSecret)) {
    return sendJson(res, 403, { error: 'Invalid map signature' });
  }

  let map;
  try {
    map = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Malformed map data' });
  }

  const staticUrl = buildStaticMapUrl({
    apiKey: config.googleKey,
    map,
    width: clamp(url.searchParams.get('w'), 400),
    height: clamp(url.searchParams.get('h'), 400),
  });

  try {
    const upstream = await fetch(staticUrl, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error('Static Maps error:', upstream.status, detail.slice(0, 300));
      return sendJson(res, 502, { error: `Static Maps returned ${upstream.status}` });
    }
    const image = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/png');
    // Same URL always renders the same picture, so let the CDN keep it.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, immutable');
    res.end(image);
  } catch (err) {
    console.error('Map fetch failed:', err);
    return sendJson(res, 502, { error: 'Could not fetch map image' });
  }
}
