import { config } from './config.js';
import { log } from './log.js';
import { isCheckpoint, store } from './session.js';

const SKIP_SRC = /turbopack|2nykiepra|27jktro|0cz1d0m/;
const ACTION_RE = /createServerReference\)\("([0-9a-f]{40,64})"[\s\S]{0,180}?reserveCampaignSpot"\)/;

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            Accept: 'text/html,application/javascript',
            'User-Agent': config.userAgent
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    return { response, text };
}

function deploymentFromHtml(html) {
    const attr = html.match(/data-(?:dpl-id|deployment-id)="([^"]+)"/i);
    if (attr) return attr[1];
    const query = html.match(/[?&]dpl=([^"&]+)/);
    if (!query) return '';
    try { return decodeURIComponent(query[1]); }
    catch { return query[1]; }
}

export async function discoverBuild() {
    let html = '';
    let blocked = false;
    for (const path of ['/campaigns', '/login']) {
        try {
            const { response, text } = await fetchText(`${config.siteOrigin}${path}`);
            if (response.status === 429 || isCheckpoint(text)) {
                blocked = true;
                continue;
            }
            if (response.ok && text) {
                html = text;
                break;
            }
        } catch (error) {
            log(`discover ${path} failed: ${error.message}`);
        }
    }

    if (!html) {
        return { blocked, actionId: store.actionId, deploymentId: store.deploymentId };
    }

    const deployment = deploymentFromHtml(html);
    if (deployment) store.deploymentId = deployment;

    const inline = html.match(ACTION_RE);
    if (inline) {
        store.actionId = inline[1];
        return { blocked: false, actionId: store.actionId, deploymentId: store.deploymentId };
    }

    const srcs = [];
    for (const match of html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g)) {
        const src = new URL(match[1], config.siteOrigin).href;
        if (SKIP_SRC.test(src)) continue;
        if (!srcs.includes(src)) srcs.push(src);
        if (!store.deploymentId) {
            const dpl = src.match(/[?&]dpl=([^&]+)/);
            if (dpl) {
                try { store.deploymentId = decodeURIComponent(dpl[1]); }
                catch { store.deploymentId = dpl[1]; }
            }
        }
    }

    for (const src of srcs.slice(0, 25)) {
        try {
            const { response, text } = await fetchText(src);
            if (!response.ok || !text) continue;
            const found = text.match(ACTION_RE);
            if (found) {
                store.actionId = found[1];
                log('discovered reserve action');
                break;
            }
        } catch {
            // The next chunk is enough if this one fails.
        }
    }

    return { blocked, actionId: store.actionId, deploymentId: store.deploymentId };
}
