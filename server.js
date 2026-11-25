const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const DEFAULT_PLAYLIST_URL = 'https://himelop.short.gy/playlist.m3u';
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKER_PROXY_URL = (process.env.WORKER_PROXY_URL || '').trim().replace(/\/+$/, '');

const allowedStreamHosts = new Set();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ALLOWED_HEADER_KEYS = new Set([
  'user-agent',
  'referer',
  'origin',
  'cookie',
  'authorization',
  'accept',
  'accept-language',
  'range',
]);

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  setCorsHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseEncodedHeaders(encoded) {
  if (!encoded) return {};
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    const sanitized = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && ALLOWED_HEADER_KEYS.has(key.toLowerCase())) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function isPrivateIp(ip) {
  const clean = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(clean)) {
    const lower = clean.toLowerCase();
    return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }
  return true;
}

async function assertPublicHost(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('Blocked private host');
  }
  if (net.isIP(lower)) {
    if (isPrivateIp(lower)) throw new Error('Blocked private IP');
    return;
  }
  const records = await dns.lookup(lower, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) {
    throw new Error('Blocked private network resolution');
  }
}

function registerHostsFromText(text) {
  const matches = text.match(/https?:\/\/[^\s"'<>|]+/gi) || [];
  for (const raw of matches) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host) allowedStreamHosts.add(host);
    } catch {
      // Ignore malformed URLs in manifests
    }
  }
}

async function requestWithRedirects(targetUrl, headers = {}, redirectsLeft = 6, trackHost = false) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  await assertPublicHost(parsed.hostname);
  if (trackHost) {
    allowedStreamHosts.add(parsed.hostname.toLowerCase());
  }

  return new Promise((resolve, reject) => {
    const client = parsed.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...headers,
    };

    const req = client.request(
      parsed,
      {
        method: 'GET',
        headers: reqHeaders,
        timeout: 15000,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 500;
        if ([301, 302, 303, 307, 308].includes(status) && upstreamRes.headers.location) {
          upstreamRes.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const nextUrl = new URL(upstreamRes.headers.location, parsed).toString();
          requestWithRedirects(nextUrl, headers, redirectsLeft - 1, trackHost).then(resolve, reject);
          return;
        }
        resolve({ upstreamRes, finalUrl: parsed.toString() });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Upstream request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

function readStreamText(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

async function handlePlaylistApi(_reqUrl, res) {
  const target = DEFAULT_PLAYLIST_URL;
  try {
    const { upstreamRes, finalUrl } = await requestWithRedirects(target, {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    });
    const status = upstreamRes.statusCode || 500;
    const text = await readStreamText(upstreamRes);

    if (status < 200 || status >= 300) {
      sendJson(res, 502, {
        error: `Playlist source returned HTTP ${status}`,
        sourceUrl: finalUrl,
      });
      return;
    }

    registerHostsFromText(text);

    sendJson(res, 200, {
      playlist: text,
      sourceUrl: finalUrl,
      etag: upstreamRes.headers.etag || null,
      workerProxyUrl: WORKER_PROXY_URL,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, 502, {
      error: err.message || 'Failed to fetch playlist',
      sourceUrl: target,
    });
  }
}

async function seedAllowedHostsIfNeeded() {
  if (allowedStreamHosts.size > 0) return;
  try {
    const { upstreamRes } = await requestWithRedirects(DEFAULT_PLAYLIST_URL);
    const text = await readStreamText(upstreamRes);
    registerHostsFromText(text);
  } catch {
    // Ignore seed failure; /api/playlist will retry
  }
}

function isManifestResponse(targetUrl, contentType = '') {
  const lowerCt = contentType.toLowerCase();
  if (lowerCt.includes('mpegurl') || lowerCt.includes('dash+xml') || lowerCt.includes('xml')) {
    return true;
  }
  return /\.(m3u8?|mpd)(\?|$)/i.test(targetUrl);
}

function isHlsPlaylist(targetUrl, contentType = '', text = '') {
  const lowerCt = contentType.toLowerCase();
  if (lowerCt.includes('mpegurl')) return true;
  if (/\.m3u8?(\?|$)/i.test(targetUrl)) return true;
  return text.trimStart().startsWith('#EXTM3U');
}

function makeProxyHref(targetUrl, encodedHeaders) {
  const params = new URLSearchParams({ url: targetUrl, rewrite: '1' });
  if (encodedHeaders) params.set('h', encodedHeaders);
  return `/api/proxy?${params.toString()}`;
}

function rewriteM3u8Manifest(manifestText, baseUrl, encodedHeaders) {
  return manifestText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => {
          try {
            const abs = new URL(rawUri, baseUrl).toString();
            if (/^https?:\/\//i.test(abs)) {
              allowedStreamHosts.add(new URL(abs).hostname.toLowerCase());
              return `URI="${makeProxyHref(abs, encodedHeaders)}"`;
            }
          } catch {
            // Keep original URI if invalid
          }
          return `URI="${rawUri}"`;
        });
      }
      try {
        const abs = new URL(trimmed, baseUrl).toString();
        if (/^https?:\/\//i.test(abs)) {
          allowedStreamHosts.add(new URL(abs).hostname.toLowerCase());
          return makeProxyHref(abs, encodedHeaders);
        }
      } catch {
        // Keep original line if invalid
      }
      return line;
    })
    .join('\n');
}

async function handleProxyApi(req, reqUrl, res) {
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { error: 'Missing url query parameter' });
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch {
    sendJson(res, 400, { error: 'Invalid url query parameter' });
    return;
  }

  await seedAllowedHostsIfNeeded();
  if (!allowedStreamHosts.has(parsedTarget.hostname.toLowerCase())) {
    sendJson(res, 403, { error: 'Host not in playlist allowlist' });
    return;
  }

  const encodedHeaders = reqUrl.searchParams.get('h') || '';
  const customHeaders = parseEncodedHeaders(encodedHeaders);
  if (req.headers.range) {
    customHeaders.Range = req.headers.range;
  }
  const shouldRewrite = reqUrl.searchParams.get('rewrite') === '1';

  try {
    const { upstreamRes, finalUrl } = await requestWithRedirects(target, customHeaders, 6, true);
    setCorsHeaders(res);

    const passHeaders = {};
    for (const name of ['content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges', 'cache-control']) {
      if (upstreamRes.headers[name]) {
        passHeaders[name] = upstreamRes.headers[name];
      }
    }
    if (!passHeaders['cache-control']) {
      passHeaders['cache-control'] = 'no-store';
    }

    if (!upstreamRes.headers['content-encoding'] && isManifestResponse(finalUrl, passHeaders['content-type'])) {
      let manifestText = await readStreamText(upstreamRes);
      registerHostsFromText(manifestText);
      if (shouldRewrite && isHlsPlaylist(finalUrl, passHeaders['content-type'], manifestText)) {
        manifestText = rewriteM3u8Manifest(manifestText, finalUrl, encodedHeaders);
      }
      delete passHeaders['content-length'];
      res.writeHead(upstreamRes.statusCode || 200, passHeaders);
      res.end(manifestText);
      return;
    }

    res.writeHead(upstreamRes.statusCode || 200, passHeaders);
    upstreamRes.pipe(res);
    req.on('close', () => {
      if (!upstreamRes.destroyed) upstreamRes.destroy();
    });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: err.message || 'Proxy error' });
    } else {
      res.end();
    }
  }
}

function handleStaticFile(reqUrl, res) {
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (reqUrl.pathname === '/api/playlist') {
    await handlePlaylistApi(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === '/api/proxy') {
    await handleProxyApi(req, reqUrl, res);
    return;
  }

  handleStaticFile(reqUrl, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Minimal M3U Player running at http://${HOST}:${PORT}`);
});
