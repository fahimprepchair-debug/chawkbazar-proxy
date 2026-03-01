/**
 * Chawk Bazar — Square API Proxy Server (v3)
 * ─────────────────────────────────────────
 * Token and location IDs stored securely as Render environment variables.
 */

const http  = require('http');
const https = require('https');

const PORT = process.env.PORT || 3131;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Square-Version, X-Square-Env',
  'Access-Control-Max-Age':       '86400',
};

const server = http.createServer((req, res) => {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    const locationIds = process.env.SQUARE_LOCATION_IDS
      ? process.env.SQUARE_LOCATION_IDS.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Chawk Bazar Square Proxy v3',
      token_configured: !!process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.SQUARE_ENVIRONMENT || 'production',
      locations_configured: locationIds.length,
      time: new Date().toISOString(),
    }));
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const token = process.env.SQUARE_ACCESS_TOKEN
    || (req.headers['authorization'] || '').replace('Bearer ', '').trim();

  const env = process.env.SQUARE_ENVIRONMENT
    || req.headers['x-square-env']
    || 'production';

  if (!token) {
    res.writeHead(401, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No access token. Set SQUARE_ACCESS_TOKEN in Render environment.' }));
    return;
  }

  const squareHost = env === 'sandbox'
    ? 'connect.squareupsandbox.com'
    : 'connect.squareup.com';

  const squarePath = (!req.url || req.url === '/') ? '/v2/orders/search' : req.url;

  console.log(`[${new Date().toISOString()}] ${req.method} ${squarePath}`);

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {

    // If this is an orders search, inject location IDs from env if available
    if (squarePath === '/v2/orders/search' && body && process.env.SQUARE_LOCATION_IDS) {
      try {
        const locationIds = process.env.SQUARE_LOCATION_IDS
          .split(',').map(s => s.trim()).filter(Boolean);
        const parsed = JSON.parse(body);
        // Override location_ids with the env var values
        parsed.location_ids = locationIds;
        body = JSON.stringify(parsed);
        console.log(`[${new Date().toISOString()}] Injecting ${locationIds.length} location IDs`);
      } catch (e) {
        console.error('Could not parse body to inject location IDs:', e.message);
      }
    }

    const options = {
      hostname: squareHost,
      port:     443,
      path:     squarePath,
      method:   req.method,
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${token}`,
        'Square-Version': '2024-01-18',
        'User-Agent':     'ChawkBazar-Proxy/3.0',
      },
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

    const proxyReq = https.request(options, proxyRes => {
      let responseBody = '';
      proxyRes.on('data', chunk => { responseBody += chunk; });
      proxyRes.on('end', () => {
        console.log(`[${new Date().toISOString()}] ← ${proxyRes.statusCode}`);
        res.writeHead(proxyRes.statusCode, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(responseBody);
      });
    });

    proxyReq.on('error', err => {
      console.error(`Proxy error: ${err.message}`);
      res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  const locationIds = process.env.SQUARE_LOCATION_IDS
    ? process.env.SQUARE_LOCATION_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  console.log('');
  console.log('  Chawk Bazar — Square Proxy v3');
  console.log('  ────────────────────────────────────');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Token set:   ${!!process.env.SQUARE_ACCESS_TOKEN}`);
  console.log(`  Environment: ${process.env.SQUARE_ENVIRONMENT || 'production'}`);
  console.log(`  Locations:   ${locationIds.length} configured`);
  console.log('  ────────────────────────────────────');
});
