import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { engine } from './engine.js';
import { captureBrowserScreenshot, closePersistentBrowser } from './browser.js';
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

const server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const origin = req.headers.origin || '';

    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
    }
    if (path === '/status') {
        if (!config.statusToken || !safeEqual(req.headers.authorization || '', `Bearer ${config.statusToken}`)) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(engine.snapshot()));
        return;
    }
    if (path === '/debug') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        });
        res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>SubsGigs browser view</title><style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 16px;background:#111;color:#eee}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #555}input{width:100%;box-sizing:border-box;background:#222;color:#fff;margin:10px 0}button{background:#eee;color:#111}img{display:block;width:100%;margin-top:20px;border:1px solid #555}#msg{color:#bbb}</style></head><body><h2>SubsGigs browser view</h2><p>Enter your Railway STATUS_TOKEN to view the current browser page.</p><input id="token" type="password" autocomplete="off" placeholder="STATUS_TOKEN"><button id="view">View current page</button><p id="msg"></p><img id="shot" alt="Current Railway browser screenshot" hidden><script>const btn=document.getElementById('view'),msg=document.getElementById('msg'),img=document.getElementById('shot');btn.onclick=async()=>{msg.textContent='Capturing…';img.hidden=true;try{const r=await fetch('/debug/screenshot',{headers:{Authorization:'Bearer '+document.getElementById('token').value},cache:'no-store'});if(!r.ok)throw new Error(r.status===404?'Access denied. Check STATUS_TOKEN.':'Screenshot unavailable ('+r.status+')');const u=URL.createObjectURL(await r.blob());if(img.dataset.url)URL.revokeObjectURL(img.dataset.url);img.dataset.url=u;img.src=u;img.hidden=false;msg.textContent='Updated';}catch(e){msg.textContent=e.message;}};</script></body></html>`);
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
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': png.length,
                'Cache-Control': 'no-store, private',
                'X-Content-Type-Options': 'nosniff',
                'Content-Disposition': 'inline; filename="subsgigs-browser.png"'
            });
            res.end(png);
        } catch (error) {
            log(`screenshot capture failed: ${error.message}`);
            send(res, 503, { error: 'Browser screenshot unavailable' });
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
