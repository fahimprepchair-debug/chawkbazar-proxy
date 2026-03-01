/**
 * Chawk Bazar — Square API Proxy Server
 * ─────────────────────────────────────
 * Runs locally on your machine and forwards requests to Square.
 * This solves the CORS issue when using the dashboard in a browser.
 *
 * HOW TO RUN:
 *   1. Install Node.js from https://nodejs.org (LTS version)
 *   2. Open Terminal (Mac) or Command Prompt (Windows)
 *   3. Navigate to this folder:  cd path/to/this/folder
 *   4. Install dependencies:     npm install
 *   5. Start the proxy:          npm start
 *   6. Leave this terminal open while using the dashboard
 *
 * The proxy runs on http://localhost:3131
 * Paste  http://localhost:3131  into the "API Proxy URL" field in the dashboard.
 */

const http = require('http');
const https = require('https');

const PORT = 3131;

// ─── Colour helpers for terminal output ──────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  gold:  '\x1b[33m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  dim:   '\x1b[2m',
  bold:  '\x1b[1m',
  cyan:  '\x1b[36m',
};

function log(symbol, color, msg) {
  const time = new Date().toLocaleTimeString();
  console.log(`${c.dim}${time}${c.reset}  ${color}${symbol}${c.reset}  ${msg}`);
}

// ─── CORS headers added to every response ────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Square-Version',
  'Access-Control-Max-Age':       '86400',
};

// ─── Main server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Only allow POST (Square order search) and GET (locations)
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Extract the Square path from the URL
  // Dashboard will call: http://localhost:3131/v2/orders/search
  // Proxy forwards to:   https://connect.squareup.com/v2/orders/search
  const squarePath = req.url;
  
  // Determine environment from Authorization header
  // (sandbox tokens start differently but we read the env from a custom header)
  const authHeader = req.headers['authorization'] || '';
  const envHeader  = req.headers['x-square-env'] || 'production';
  
  const squareHost = envHeader === 'sandbox'
    ? 'connect.squareupsandbox.com'
    : 'connect.squareup.com';

  log('→', c.cyan, `${req.method} ${squarePath} (${envHeader})`);

  // Collect request body
  let body = '';
  req.on('data', chunk => { body += chunk; });

  req.on('end', () => {
    const options = {
      hostname: squareHost,
      port:     443,
      path:     squarePath,
      method:   req.method,
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   authHeader,
        'Square-Version':  req.headers['square-version'] || '2024-01-18',
        'User-Agent':      'ChawkBazar-Dashboard/1.0',
      },
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const proxyReq = https.request(options, proxyRes => {
      let responseBody = '';
      proxyRes.on('data', chunk => { responseBody += chunk; });
      proxyRes.on('end', () => {
        const status = proxyRes.statusCode;
        const color  = status < 300 ? c.green : c.red;
        log(status < 300 ? '✓' : '✗', color, `${status} from Square`);

        res.writeHead(status, {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
        });
        res.end(responseBody);
      });
    });

    proxyReq.on('error', err => {
      log('✗', c.red, `Proxy error: ${err.message}`);
      res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log(`  ${c.gold}${c.bold}Chawk Bazar — Square Proxy${c.reset}`);
  console.log(`  ${'─'.repeat(36)}`);
  console.log(`  ${c.green}✓ Running on${c.reset}  http://localhost:${PORT}`);
  console.log(`  ${c.dim}Paste this URL into the dashboard:${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}http://localhost:${PORT}${c.reset}`);
  console.log(`  ${'─'.repeat(36)}`);
  console.log(`  ${c.dim}Press Ctrl+C to stop${c.reset}`);
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ${c.red}✗ Port ${PORT} is already in use.${c.reset}`);
    console.error(`  Try stopping other processes or change PORT in server.js\n`);
  } else {
    console.error(`\n  ${c.red}✗ Server error: ${err.message}${c.reset}\n`);
  }
  process.exit(1);
});
