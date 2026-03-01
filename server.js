/**
 * Chawk Bazar — Square API Proxy Server (v4)
 * ─────────────────────────────────────────
 * Handles Square's 10 location ID limit by splitting into
 * multiple requests and merging the results automatically.
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

// ── Split array into chunks of N ─────────────────────────────────────────────
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ── Make a single HTTPS request to Square ────────────────────────────────────
function squareRequest(path, method, body, token, env) {
  return new Promise((resolve, reject) => {
    const squareHost = env === 'sandbox'
      ? 'connect.squareupsandbox.com'
      : 'connect.squareup.com';

    const bodyStr = body ? JSON.stringify(body) : '';

    const options = {
      hostname: squareHost,
      port:     443,
      path,
      method,
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${token}`,
        'Square-Version': '2024-01-18',
        'User-Agent':     'ChawkBazar-Proxy/4.0',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: { error: 'Invalid JSON response' } });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Main server ───────────────────────────────────────────────────────────────
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
      service: 'Chawk Bazar Square Proxy v4',
      token_configured: !!process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.SQUARE_ENVIRONMENT || 'production',
      locations_configured: locationIds.length,
      batches_needed: Math.ceil(locationIds.length / 10),
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

  const squarePath = (!req.url || req.url === '/') ? '/v2/orders/search' : req.url;

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {

    // ── Orders search: batch by location IDs ──────────────────────────────
    if (squarePath === '/v2/orders/search' && process.env.SQUARE_LOCATION_IDS) {
      try {
        const allLocationIds = process.env.SQUARE_LOCATION_IDS
          .split(',').map(s => s.trim()).filter(Boolean);

        const batches = chunk(allLocationIds, 10);
        console.log(`[${new Date().toISOString()}] Searching orders across ${allLocationIds.length} locations in ${batches.length} batches`);

        let parsedBody = {};
        try { parsedBody = JSON.parse(body); } catch (e) {}

        // Fire all batch requests in parallel
        const results = await Promise.all(
          batches.map((locationBatch, i) => {
            const batchBody = {
              ...parsedBody,
              location_ids: locationBatch,
            };
            console.log(`[${new Date().toISOString()}] Batch ${i + 1}/${batches.length}: ${locationBatch.join(', ')}`);
            return squareRequest('/v2/orders/search', 'POST', batchBody, token, env);
          })
        );

        // Check for errors
        const firstError = results.find(r => r.status !== 200 && r.body.errors);
        if (firstError) {
          console.error(`[${new Date().toISOString()}] Square error: ${JSON.stringify(firstError.body.errors)}`);
          res.writeHead(firstError.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(firstError.body));
          return;
        }

        // Merge all orders from all batches
        const allOrders = results.flatMap(r => r.body.orders || []);

        // Sort by created_at
        allOrders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        console.log(`[${new Date().toISOString()}] ✓ Merged ${allOrders.length} orders from ${batches.length} batches`);

        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders: allOrders }));

      } catch (err) {
        console.error(`Batch error: ${err.message}`);
        res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Batch request failed', detail: err.message }));
      }
      return;
    }

    // ── All other endpoints: forward as-is ────────────────────────────────
    try {
      const result = await squareRequest(squarePath, req.method, body ? JSON.parse(body) : null, token, env);
      res.writeHead(result.status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    }
  });
});

server.listen(PORT, () => {
  const locationIds = process.env.SQUARE_LOCATION_IDS
    ? process.env.SQUARE_LOCATION_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  console.log('');
  console.log('  Chawk Bazar — Square Proxy v4');
  console.log('  ────────────────────────────────────');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Token set:   ${!!process.env.SQUARE_ACCESS_TOKEN}`);
  console.log(`  Environment: ${process.env.SQUARE_ENVIRONMENT || 'production'}`);
  console.log(`  Locations:   ${locationIds.length} (${Math.ceil(locationIds.length / 10)} batches of 10)`);
  console.log('  ────────────────────────────────────');
});

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
