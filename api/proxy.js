export const config = {
  runtime: 'edge', 
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':  'Range, Content-Type, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
    'Accept-Ranges':                 'bytes',
  };
}

function browserHeaders(referer, origin, customUA) {
  const h = {
    'User-Agent':         customUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':             '*/*',
    'Accept-Language':    'en-US,en;q=0.9',
    'Accept-Encoding':    'gzip, deflate, br',
    'Sec-Fetch-Dest':     'empty',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Site':     'cross-site',
    'Connection':         'keep-alive',
  };
  if (referer) h['Referer'] = referer;
  if (origin)  h['Origin']  = origin;
  return h;
}

function resolveUrl(relativeUrl, baseUrl) {
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  try { return new URL(relativeUrl, baseUrl).href; } catch { return relativeUrl; }
}

/* ─── Smart Playlist Stream Rewriter ─────────────────────────────────────── */
function rewriteM3u8(text, baseUrl, referer, origin, ua, workerOrigin) {
  const lines = text.split('\n');
  
  // Build the parameters string dynamically to pass headers down to individual chunks
  let paramSuffix = `&ref=${encodeURIComponent(referer)}`;
  if (origin) paramSuffix += `&orig=${encodeURIComponent(origin)}`;
  if (ua) paramSuffix += `&ua=${encodeURIComponent(ua)}`;

  return lines.map(raw => {
    const line = raw.trim();

    if (line.startsWith('#') && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absUrl = resolveUrl(uri, baseUrl);
        return `URI="${workerOrigin}/api/proxy?url=${encodeURIComponent(absUrl)}${paramSuffix}"`;
      });
    }

    if (line && !line.startsWith('#')) {
      const absUrl = resolveUrl(line, baseUrl);
      return `${workerOrigin}/api/proxy?url=${encodeURIComponent(absUrl)}${paramSuffix}`;
    }

    return raw;
  }).join('\n');
}

/* ─── Request Handler ────────────────────────────────────────────────────── */
export default async function handler(request) {
  const urlObj = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const targetUrl = urlObj.searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing required parameter '?url='" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  /* ─── Extract Dynamic Header Mappings ─── */
  let referer = urlObj.searchParams.get('ref') || '';
  let origin = urlObj.searchParams.get('orig') || '';
  let ua = urlObj.searchParams.get('ua') || '';

  // AUTOMATED SAFETY: If targeting owocdn/uwucdn and referer isn't explicitly set right, force kwik.cx
  if ((targetUrl.includes('owocdn.top') || targetUrl.includes('uwucdn.top')) && (!referer || referer.includes('miruro'))) {
    referer = 'https://kwik.cx';
  }

  const headers = browserHeaders(referer, origin, ua);
  
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) headers['Range'] = rangeHeader;

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Upstream dispatch failed", detail: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
    return new Response(JSON.stringify({ 
      error: "Upstream server rejected proxy payload", 
      status: upstreamResponse.status,
      attemptedReferer: referer
    }), {
      status: upstreamResponse.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  const contentType = (upstreamResponse.headers.get('Content-Type') || '').toLowerCase();
  const isM3u8Manifest = contentType.includes('mpegurl') || contentType.includes('x-mpegurl') || targetUrl.split('?')[0].endsWith('.m3u8');

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: upstreamResponse.status,
      headers: { 'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/octet-stream', ...corsHeaders() }
    });
  }

  if (isM3u8Manifest) {
    const textData = await upstreamResponse.text();
    const rewrittenManifest = rewriteM3u8(textData, targetUrl, referer, origin, ua, urlObj.origin);
    return new Response(rewrittenManifest, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...corsHeaders()
      }
    });
  }

  const binaryHeaders = {
    'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400, immutable',
    ...corsHeaders()
  };
  if (upstreamResponse.headers.get('Content-Length')) binaryHeaders['Content-Length'] = upstreamResponse.headers.get('Content-Length');
  if (upstreamResponse.headers.get('Content-Range'))  binaryHeaders['Content-Range']  = upstreamResponse.headers.get('Content-Range');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: binaryHeaders
  });
}
