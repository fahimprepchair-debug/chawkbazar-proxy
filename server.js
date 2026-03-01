const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3131;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Square-Version, X-Square-Env',
  'Access-Control-Max-Age': '86400'
};

function chunkArray(arr, size) {
  var result = [];
  for (var i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function squareCall(path, method, body, token, env) {
  return new Promise(function(resolve, reject) {
    var host = env === 'sandbox' ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
    var bodyStr = body ? JSON.stringify(body) : '';
    var opts = {
      hostname: host,
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Square-Version': '2024-01-18',
        'User-Agent': 'ChawkBazar/4.0'
      }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    var req = https.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: { error: 'bad json' } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

var server = http.createServer(function(req, res) {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    var locs = process.env.SQUARE_LOCATION_IDS
      ? process.env.SQUARE_LOCATION_IDS.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
      : [];
    res.writeHead(200, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Chawk Bazar Proxy v4',
      token_configured: !!process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.SQUARE_ENVIRONMENT || 'production',
      locations_configured: locs.length,
      batches_needed: Math.ceil(locs.length / 10),
      time: new Date().toISOString()
    }));
    return;
  }

  var token = process.env.SQUARE_ACCESS_TOKEN
    || (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  var env = process.env.SQUARE_ENVIRONMENT || req.headers['x-square-env'] || 'production';

  if (!token) {
    res.writeHead(401, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({ error: 'No token configured' }));
    return;
  }

  var sqPath = (!req.url || req.url === '/') ? '/v2/orders/search' : req.url;
  var body = '';
  req.on('data', function(c) { body += c; });

  req.on('end', function() {
    if (sqPath === '/v2/orders/search' && process.env.SQUARE_LOCATION_IDS) {
      var allLocs = process.env.SQUARE_LOCATION_IDS
        .split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      var batches = chunkArray(allLocs, 10);
      var parsedBody = {};
      try { parsedBody = JSON.parse(body); } catch(e) {}

      console.log('Searching ' + allLocs.length + ' locations in ' + batches.length + ' batches');

      Promise.all(batches.map(function(batch) {
        var batchBody = Object.assign({}, parsedBody, { location_ids: batch });
        return squareCall('/v2/orders/search', 'POST', batchBody, token, env);
      })).then(function(results) {
        var firstErr = null;
        for (var i = 0; i < results.length; i++) {
          if (results[i].status !== 200 && results[i].body.errors) {
            firstErr = results[i];
            break;
          }
        }
        if (firstErr) {
          res.writeHead(firstErr.status, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
          res.end(JSON.stringify(firstErr.body));
          return;
        }
        var allOrders = [];
        results.forEach(function(r) {
          (r.body.orders || []).forEach(function(o) { allOrders.push(o); });
        });
        allOrders.sort(function(a, b) { return new Date(a.created_at) - new Date(b.created_at); });
        console.log('Done - ' + allOrders.length + ' orders');
        res.writeHead(200, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ orders: allOrders }));
      }).catch(function(err) {
        res.writeHead(502, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'Batch error', detail: err.message }));
      });
      return;
    }

    var parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch(e) {}
    squareCall(sqPath, req.method, parsed, token, env).then(function(result) {
      res.writeHead(result.status, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(result.body));
    }).catch(function(err) {
      res.writeHead(502, Object.assign({}, CORS, { 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    });
  });
});

server.listen(PORT, function() {
  var locs = process.env.SQUARE_LOCATION_IDS
    ? process.env.SQUARE_LOCATION_IDS.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
    : [];
  console.log('Chawk Bazar Proxy v4 running on port ' + PORT);
  console.log('Token: ' + (!!process.env.SQUARE_ACCESS_TOKEN) + ' | Locations: ' + locs.length + ' | Batches: ' + Math.ceil(locs.length / 10));
});
