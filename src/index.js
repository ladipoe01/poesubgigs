import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { engine } from './engine.js';
import { captureBrowserScreenshot, closePersistentBrowser } from './browser.js';
import { sendTelegramPhoto } from './telegram.js';
import { applySession, coerceSession } from './session.js';
import { log } from './log.js';

const transferToken = process.env.SG_TRANSFER_TOKEN || '';

function send(res, status, body, origin = '') {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (origin === config.siteOrigin) {
        headers['Access-Control-Allow-Origin'] = config.siteOrigin;
        headers['Vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && timingSafeEqual(left, right);
}

const server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const origin = req.headers.origin || '';

    if (path === '/session-transfer' && req.method === 'OPTIONS') {
        if (origin !== config.siteOrigin) return send(res, 403, { ok: false });
        res.writeHead(204, {
            'Access-Control-Allow-Origin': config.siteOrigin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '300',
            'Vary': 'Origin'
        });
        return res.end();
    }

    if (path === '/session-transfer' && req.method === 'POST') {
        if (!transferToken || origin !== config.siteOrigin) return send(res, 403, { ok: false }, origin);

        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 65536) {
                send(res, 413, { ok: false }, origin);
                req.destroy();
            }
        });
        req.on('end', () => {
            let payload;
            try { payload = JSON.parse(raw); } catch { return send(res, 400, { ok: false }, origin); }
            if (!safeEqual(payload?.transferToken || '', transferToken)) {
                return send(res, 403, { ok: false }, origin);
            }
            const session = coerceSession(payload?.session?.currentSession || payload?.session);
            if (!session?.refresh_token) return send(res, 400, { ok: false, error: 'valid refresh session required' }, origin);

            try {
                applySession(session);
                log('one-time browser session transfer accepted');
                send(res, 200, { ok: true }, origin);
                return;
            } catch (error) {
                return send(res, 500, { ok: false, error: 'could not persist transferred session' }, origin);
            }
        });
        return;
    }

    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
    }
    if (path === '/debug/screenshot') {
        if (req.method !== 'GET' || !config.statusToken || !safeEqual(req.headers.authorization || '', `Bearer ${config.statusToken}`)) {
            res.writeHead(404, { 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        try {
            const png = await captureBrowserScreenshot();
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' });
            res.end(png);
        } catch (error) {
            log(`screenshot endpoint unavailable: ${error.message}`);
            send(res, 503, { error: 'Browser screenshot unavailable' });
        }
        return;
    }
    if (path === '/status') {
        if (!config.statusToken || !safeEqual(req.headers.authorization || '', `Bearer ${config.statusToken}`) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        const snapshot = engine.snapshot();
        res.end(JSON.stringify(snapshot));
        try {
            const png = await captureBrowserScreenshot();
            await sendTelegramPhoto(png, `SubsGigs status: ${snapshot.label}`);
        } catch (error) {
            log(`status screenshot unavailable: ${error.message}`);
        }
        return;
    }
    res.writeHead(404);
    res.end();
});

server.listen(config.port, '0.0.0.0', () => {
    log(`health on :${config.port}/health`);
});

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received`);
    engine.stop();
    const started = Date.now();
    while (engine.busy() && Date.now() - started < 14000) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await closePersistentBrowser();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('unhandledRejection', error => {
    log(`unhandled: ${error && error.message ? error.message : error}`);
});

engine.boot()
    .then(() => engine.start())
    .catch(error => {
        log(`boot failed: ${error.message}`);
        engine.start();
    });
