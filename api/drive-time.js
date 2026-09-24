import { buildCommute, missingConfig, readConfig } from '../lib/commute.js';
import { UpstreamError } from '../lib/google.js';
import { publicBaseUrl, requestUrl, sendJson } from '../lib/http.js';

export default async function handler(req, res) {
  const config = readConfig();
  const missing = missingConfig(config);
  if (missing.length) {
    return sendJson(res, 500, { error: `Missing environment variables: ${missing.join(', ')}` });
  }

  try {
    const url = requestUrl(req);
    const commute = await buildCommute(config, {
      direction: url.searchParams.get('direction'),
      baseUrl: publicBaseUrl(req),
    });
    // A one-minute edge cache absorbs repeated previews without making the
    // display stale; TRMNL itself polls every 5+ minutes.
    return sendJson(res, 200, commute, 'public, max-age=0, s-maxage=60');
  } catch (err) {
    console.error('Commute lookup failed:', err);
    if (err instanceof UpstreamError) {
      return sendJson(res, 502, { error: err.message });
    }
    return sendJson(res, err.status ?? 500, { error: err.message ?? 'Could not fetch drive time' });
  }
}
