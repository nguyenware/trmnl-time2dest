// Local server that mimics the Vercel routes: `npm run dev`, then open
// http://localhost:3000/drive-time
import { createServer } from 'node:http';
import driveTime from '../api/drive-time.js';
import map from '../api/map.js';

const routes = { '/drive-time': driveTime, '/api/drive-time': driveTime, '/map': map, '/api/map': map };
const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  const handler = routes[new URL(req.url, 'http://localhost').pathname];
  if (handler) return handler(req, res);
  res.statusCode = 404;
  res.end('Not found');
}).listen(port, () => console.log(`http://localhost:${port}/drive-time`));
