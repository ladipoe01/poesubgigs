import { chromium } from 'playwright';
import { config } from './config.js';
import { cookieHeader } from './session.js';
import { log } from './log.js';

let context;
let page;
let starting;

const checkpointPattern = /security checkpoint|verify you are human|checking your browser|vercel security|challenge-platform/i;

function responseLike(result) {
    const headers = new Map((result.headers || []).map(([key, value]) => [String(key).toLowerCase(), value]));
    return {
        status: result.status,
        url: result.url,
        headers: {
            get(name) { return headers.get(String(name).toLowerCase()) || null; },
            getSetCookie() { return []; }
        },
        async text() { return result.body || ''; }
    };
}

async function seedAuthCookies() {
    const raw = cookieHeader();
    if (!raw || !context) return;
    const cookies = raw.split(/;\s*/).map(part => {
        const at = part.indexOf('=');
        if (at < 1) return null;
        const name = part.slice(0, at);
        const value = part.slice(at + 1);
        if (!/^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/.test(name)) return null;
        return { name, value, url: config.siteOrigin, secure: config.siteOrigin.startsWith('https:'), sameSite: 'Lax' };
    }).filter(Boolean);
    if (cookies.length) await context.addCookies(cookies);
}

export async function startPersistentBrowser() {
    if (context) return page;
    if (starting) return starting;
    starting = (async () => {
        context = await chromium.launchPersistentContext(config.browserProfilePath, {
            headless: true,
            viewport: { width: 1365, height: 900 },
            args: ['--no-sandbox']
        });
        page = context.pages()[0] || await context.newPage();
        await seedAuthCookies();
        try {
            const response = await page.goto(`${config.siteOrigin}/campaigns`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            const html = await page.content().catch(() => '');
            if (response?.status() === 429 || checkpointPattern.test(html)) {
                log('Vercel checkpoint detected in persistent browser; saves will pause until the site allows access');
            } else {
                log('persistent browser profile ready');
            }
        } catch (error) {
            log(`browser warm-up failed: ${error.message}`);
        }
        return page;
    })();
    try {
        return await starting;
    } finally {
        starting = null;
    }
}

export async function submitCampaign(campaignId, actionId, routerTree, deploymentId) {
    await startPersistentBrowser();
    await seedAuthCookies();

    const currentHtml = await page.content().catch(() => '');
    if (checkpointPattern.test(currentHtml)) {
        return responseLike({
            status: 403,
            url: page.url(),
            headers: [],
            body: 'Vercel security checkpoint detected. The worker will not attempt to bypass it.'
        });
    }

    const result = await page.evaluate(async ({ campaignId, actionId, routerTree, deploymentId }) => {
        const body = new FormData();
        body.append('_1_campaignId', String(campaignId));
        body.append('0', '[{},"$K1"]');
        try {
            const response = await fetch('/campaigns', {
                method: 'POST',
                body,
                credentials: 'include',
                cache: 'no-store',
                redirect: 'follow',
                headers: {
                    Accept: 'text/x-component',
                    'next-action': actionId,
                    'next-router-state-tree': routerTree,
                    'x-deployment-id': deploymentId
                }
            });
            return {
                status: response.status,
                url: response.url,
                headers: [...response.headers.entries()],
                body: await response.text()
            };
        } catch (error) {
            return { status: 0, url: location.href, headers: [], body: String(error?.message || error) };
        }
    }, { campaignId, actionId, routerTree, deploymentId });

    if (result.status === 403 || result.status === 429 || checkpointPattern.test(result.body || '')) {
        log('browser submission received a checkpoint or rate limit response');
    }
    return responseLike(result);
}

export async function closePersistentBrowser() {
    if (!context) return;
    const active = context;
    context = null;
    page = null;
    await active.close().catch(() => {});
}
