// Small helpers that work with both Vercel's Node runtime and a plain
// node:http server (used by scripts/dev.js).

export function sendJson(res, status, body, cacheControl = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(body));
}

export function requestUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  return new URL(req.url ?? '/', `${proto}://${host}`);
}

export function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  return configured || requestUrl(req).origin;
}
