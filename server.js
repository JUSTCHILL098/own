const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Wide-open CORS configuration for HTML5 Players (Vidstack, HLS.js, Plyr)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
    res.header('Accept-Ranges', 'bytes');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Helper to convert relative HLS paths to absolute target paths
function resolveUrl(relativeUrl, baseUrl) {
    if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
    try {
        return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
        return relativeUrl;
    }
}

// Deep Manifest Parser: Rewrites segment lines into proxied routing loops
function rewriteM3u8(text, baseUrl, referer, hostOrigin) {
    const lines = text.split('\n');
    return lines.map(line => {
        const trimmed = line.trim();

        // 1. Handle nested variant sub-playlists (e.g., Yuki resolution maps)
        if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                const absUrl = resolveUrl(uri, baseUrl);
                return `URI="${hostOrigin}/proxy?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}"`;
            });
        }

        // 2. Handle standard video chunk segments (.ts tracks)
        if (trimmed && !trimmed.startsWith('#')) {
            const absUrl = resolveUrl(trimmed, baseUrl);
            return `${hostOrigin}/proxy?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
        }

        return line;
    }).join('\n');
}

// The Core Proxy Route
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing target ?url= parameter' });
    }

    // Dynamic Header Spoofing Engine
    const customReferer = req.query.ref || req.query.referer || '';
    let targetHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive'
    };

    if (customReferer) {
        targetHeaders['Referer'] = customReferer;
        try {
            targetHeaders['Origin'] = new URL(customReferer).origin;
        } catch (e) {
            // Fallback if referer isn't a valid full URL
        }
    }

    // Pass downstream partial range video seeking requests (crucial for scrubbing timelines)
    if (req.headers.range) {
        targetHeaders['Range'] = req.headers.range;
    }

    try {
        // Execute stream download via Axios handling binary chunks
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: targetHeaders,
            responseType: 'stream',
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 300
        });

        // Pipe standard content type markers cleanly back to the frontend browser player
        const contentType = response.headers['content-type'] || '';
        const isM3u8 = contentType.includes('mpegurl') || contentType.includes('x-mpegurl') || targetUrl.split('?')[0].endsWith('.m3u8');

        if (isM3u8) {
            // Buffer text data fully to run regex string manipulation replacements
            let manifestText = '';
            response.data.on('data', chunk => { manifestText += chunk; });
            response.data.on('end', () => {
                const hostOrigin = `${req.protocol}://${req.get('host')}`;
                const rewrittenManifest = rewriteM3u8(manifestText, targetUrl, customReferer, hostOrigin);
                
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.send(rewrittenManifest);
            });
        } else {
            // Directly stream binary raw data fragments (.ts / .mp4 files)
            if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
            if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
            if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
            if (response.status === 206) res.status(206);

            response.data.pipe(res);
        }

    } catch (error) {
        res.status(502).json({
            error: 'Render node failed to bridge video asset pipeline target destination',
            message: error.message
        });
    }
});

// Health check endpoint
app.get('/', (req, res) => res.json({ status: 'online', service: 'render-media-proxy' }));

app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
