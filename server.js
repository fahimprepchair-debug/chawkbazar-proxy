const http  = require('http');
const https = require('https');

const PORT = process.env.PORT || 3131;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Square-Version, X-Square-Env',
  'Access-Control-Max-Age':       '86400',
};

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function squareRequest(path, method, body, token, env) {
  return new Promise((resolve, reject) => {
    const host = env === 'sandbox' ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: host, port: 443, path, method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2024-01-18',
        'User-Agent': 'ChawkBazar-Proxy/4.0',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: { error: 'Invalid JSON' } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const server = http.createServer((req, res) => {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    const locs = process.env.SQUARE_LOCATION_ID
