const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Absolute unrestricted CORS headers required for media injection
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, X-Requested-With, Referer, Origin');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
    res.header('Accept-Ranges', 'bytes');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

function resolveUrl(relativeUrl, baseUrl) {
    if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
    try {
        return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
        return relativeUrl;
    }
}

function rewriteM3u8(text, baseUrl, referer, hostOrigin) {
    const lines = text.split('\n');
    return lines.map(line => {
        const trimmed = line.trim();

        if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                const absUrl = resolveUrl(uri, baseUrl);
                return `URI="${hostOrigin}/proxy?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}"`;
            });
        }

        if (trimmed && !trimmed.startsWith('#')) {
            const absUrl = resolveUrl(trimmed, baseUrl);
            return `${hostOrigin}/proxy?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
        }

        return line;
    }).join('\n');
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing target ?url= parameter' });
    }

    const customReferer = req.query.ref || req.query.referer || 'https://kwik.cx/';
    let targetOrigin = 'https://kwik.cx';
    
    try {
        if (customReferer) targetOrigin = new URL(customReferer).origin;
    } catch(e) {}

    // STAGE 2 ANTI-BOT BYPASS: Strict Chrome header emulation matrix
    const strictHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': customReferer,
        'Origin': targetOrigin,
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    };

    if (req.headers.range) {
        strictHeaders['Range'] = req.headers.range;
    }

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: strictHeaders,
            responseType: 'stream',
            timeout: 20000,
            // CRITICAL: Prevent axios from auto-injecting tracking proxies or structural metadata modifications
            decompress: true, 
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400
        });

        const contentType = response.headers['content-type'] || '';
        const isM3u8 = contentType.includes('mpegurl') || contentType.includes('x-mpegurl') || targetUrl.split('?')[0].endsWith('.m3u8');

        if (isM3u8) {
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
            // Forward headers directly back to player engine pipelines
            if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
            if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
            if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
            if (response.status === 206) res.status(206);

            response.data.pipe(res);
        }

    } catch (error) {
        res.status(502).json({
            error: "OwoCDN bypass engine dropped connection stream.",
            message: error.message,
            details: error.response ? error.response.status : "No response body received"
        });
    }
});

app.get('/', (req, res) => res.json({ status: 'online', engine: 'v3-hardened' }));

app.listen(PORT, () => console.log(`Proxy running securely on port ${PORT}`));
