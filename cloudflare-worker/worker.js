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

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
  };
}

function isIpLiteralOrPrivateHost(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(lower) ||
    lower.includes(':')
  ) {
    return true;
  }
  return false;
}

function parseEncodedHeaders(encoded) {
  if (!encoded) return {};
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
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

function isHlsPlaylist(targetUrl, contentType = '', text = '') {
  const lowerCt = contentType.toLowerCase();
  if (lowerCt.includes('mpegurl')) return true;
  if (/\.m3u8?(\?|$)/i.test(targetUrl)) return true;
  return text.trimStart().startsWith('#EXTM3U');
}

function makeWorkerProxyHref(workerOrigin, targetUrl, encodedHeaders) {
  const params = new URLSearchParams({ url: targetUrl, rewrite: '1' });
  if (encodedHeaders) params.set('h', encodedHeaders);
  return `${workerOrigin}/?${params.toString()}`;
}

function rewriteM3u8Manifest(manifestText, baseUrl, workerOrigin, encodedHeaders) {
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
              return `URI="${makeWorkerProxyHref(workerOrigin, abs, encodedHeaders)}"`;
            }
          } catch {
            // Keep original URI
          }
          return `URI="${rawUri}"`;
        });
      }
      try {
        const abs = new URL(trimmed, baseUrl).toString();
        if (/^https?:\/\//i.test(abs)) {
          return makeWorkerProxyHref(workerOrigin, abs, encodedHeaders);
        }
      } catch {
        // Keep original line
      }
      return line;
    })
    .join('\n');
}

function resolveAllowedOrigin(request, env) {
  const configured = (env?.ALLOWED_ORIGIN || '*').trim();
  if (configured === '*') return '*';
  const allowed = configured.split(',').map((s) => s.trim()).filter(Boolean);
  const reqOrigin = request.headers.get('Origin') || '';
  if (allowed.includes(reqOrigin)) return reqOrigin;
  return null;
}

export default {
  async fetch(request, env) {
    const allowedOrigin = resolveAllowedOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin || '*'),
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (allowedOrigin === null) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ status: 'ok', service: 'showmo-proxy' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...corsHeaders(allowedOrigin),
        },
      });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(allowedOrigin) },
      });
    }

    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      return new Response(JSON.stringify({ error: 'Unsupported protocol' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(allowedOrigin) },
      });
    }

    if (isIpLiteralOrPrivateHost(parsedTarget.hostname)) {
      return new Response(JSON.stringify({ error: 'Direct IP or private host blocked' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(allowedOrigin) },
      });
    }

    const encodedHeaders = reqUrl.searchParams.get('h') || '';
    const customHeaders = parseEncodedHeaders(encodedHeaders);
    const range = request.headers.get('Range');
    if (range) customHeaders.Range = range;
    if (!customHeaders['User-Agent'] && !customHeaders['user-agent']) {
      customHeaders['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    try {
      const upstreamRes = await fetch(target, {
        method: request.method,
        headers: customHeaders,
        redirect: 'follow',
      });

      const outHeaders = new Headers(corsHeaders(allowedOrigin));
      for (const key of ['content-type', 'content-range', 'accept-ranges', 'cache-control']) {
        const val = upstreamRes.headers.get(key);
        if (val) outHeaders.set(key, val);
      }
      if (!outHeaders.has('cache-control')) {
        outHeaders.set('cache-control', 'no-store');
      }

      const shouldRewrite = reqUrl.searchParams.get('rewrite') === '1';
      const finalUrl = upstreamRes.url || target;
      const contentType = upstreamRes.headers.get('content-type') || '';

      if (shouldRewrite && (isHlsPlaylist(finalUrl, contentType) || isHlsPlaylist(target, contentType))) {
        const text = await upstreamRes.text();
        const rewritten = rewriteM3u8Manifest(text, finalUrl, reqUrl.origin, encodedHeaders);
        return new Response(rewritten, {
          status: upstreamRes.status,
          headers: outHeaders,
        });
      }

      const contentLength = upstreamRes.headers.get('content-length');
      const hasEncoding = upstreamRes.headers.has('content-encoding');
      if (contentLength && !hasEncoding) {
        outHeaders.set('content-length', contentLength);
      }

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: outHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || 'Upstream fetch failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(allowedOrigin) },
      });
    }
  },
};
