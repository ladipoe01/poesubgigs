import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { engine } from './engine.js';
import { closePersistentBrowser } from './browser.js';
import { log } from './log.js';


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

const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const origin = req.headers.origin || '';

    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
    }
    if (path === '/status') {
        if (!config.statusToken || req.headers.authorization !== `Bearer ${config.statusToken}`) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(engine.snapshot()));
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
