import http from 'node:http';
import { config } from './config.js';
import { engine } from './engine.js';
import { closePersistentBrowser } from './browser.js';
import { log } from './log.js';

const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
