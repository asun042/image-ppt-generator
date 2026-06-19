const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DEPLOY_RUN_PORT || 5000;
const STATIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Serve static files
function serveStatic(req, res) {
  let filePath = new URL(req.url, 'http://localhost').pathname;
  if (filePath === '/') filePath = '/index.html';
  
  const fullPath = path.join(STATIC_DIR, filePath);
  const safePath = fullPath.startsWith(STATIC_DIR) ? fullPath : null;
  
  if (!safePath || !fs.existsSync(safePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Don't serve server.js or .coze
  if (safePath.endsWith('server.js') || safePath.endsWith('.coze')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getMimeType(safePath),
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Proxy API requests
function proxyRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const { targetUrl, method, headers, body: requestBody } = params;

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing targetUrl' }));
        return;
      }

      // Parse target URL using WHATWG URL API
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method || 'POST',
        headers: {},
      };

      // Forward headers (sanitize)
      if (headers) {
        const safeHeaders = ['content-type', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access', 'accept'];
        for (const [key, value] of Object.entries(headers)) {
          if (safeHeaders.includes(key.toLowerCase())) {
            options.headers[key] = value;
          }
        }
      }

      // Set content-length
      const reqBody = requestBody ? JSON.stringify(requestBody) : '';
      if (reqBody) {
        options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(reqBody);
      }

      const proxyModule = isHttps ? https : http;
      const proxyReq = proxyModule.request(options, (proxyRes) => {
        // Collect response body
        let responseBody = '';
        proxyRes.on('data', chunk => { responseBody += chunk; });
        proxyRes.on('end', () => {
          // Forward response headers
          const resHeaders = {};
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            // Skip CORS and security headers that might conflict
            if (!['access-control-allow-origin', 'access-control-allow-credentials'].includes(key.toLowerCase())) {
              resHeaders[key] = value;
            }
          }
          // Add CORS headers for browser
          resHeaders['Access-Control-Allow-Origin'] = '*';
          resHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
          resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, x-api-key, anthropic-version';

          res.writeHead(proxyRes.statusCode, resHeaders);
          res.end(responseBody);
        });
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message);
        res.writeHead(502, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
      });

      if (reqBody) {
        proxyReq.write(reqBody);
      }
      proxyReq.end();
    } catch (err) {
      res.writeHead(400, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: `Parse error: ${err.message}` }));
    }
  });
}

// Main server
const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // Proxy endpoint
  if (req.method === 'POST' && req.url === '/api/proxy') {
    proxyRequest(req, res);
    return;
  }

  // Image download proxy - downloads binary image and returns base64
  if (req.method === 'POST' && req.url === '/api/download-image') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { imageUrl } = JSON.parse(body);
        if (!imageUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing imageUrl' }));
          return;
        }
        const parsedUrl = new URL(imageUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        };
        const proxyModule = isHttps ? https : http;
        const proxyReq = proxyModule.request(options, (proxyRes) => {
          const chunks = [];
          proxyRes.on('data', chunk => { chunks.push(chunk); });
          proxyRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const contentType = proxyRes.headers['content-type'] || 'image/png';
            const base64 = buffer.toString('base64');
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({
              dataUrl: `data:${contentType};base64,${base64}`,
              size: buffer.length,
            }));
          });
        });
        proxyReq.on('error', (err) => {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: `Download failed: ${err.message}` }));
        });
        proxyReq.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `Parse error: ${err.message}` }));
      }
    });
    return;
  }

  // Static files
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
