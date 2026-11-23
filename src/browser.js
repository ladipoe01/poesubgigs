import { chromium } from 'playwright';
import { config } from './config.js';
import { cookieHeader } from './session.js';
import { log } from './log.js';

let context;
let page;
let starting;
let lastNavigationStatus = 0;
let checkpointDetected = false;

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
            lastNavigationStatus = response?.status() || 0;
            const html = await page.content().catch(() => '');
            checkpointDetected = lastNavigationStatus === 403 || checkpointPattern.test(html);
            if (checkpointDetected) {
                log(`site access checkpoint detected during page navigation (HTTP ${lastNavigationStatus || 'unknown'}); automation must remain paused`);
            } else if (lastNavigationStatus === 429) {
                log('site rate limit detected during page navigation; automation must remain paused');
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

export async function getBrowserDiagnostics() {
    if (!page || page.isClosed()) return { ready: false, url: '', title: '', httpStatus: lastNavigationStatus, checkpoint: checkpointDetected };
    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const checkpoint = checkpointDetected || lastNavigationStatus === 403 || checkpointPattern.test(html);
    checkpointDetected = checkpoint;
    return { ready: true, url: page.url(), title, httpStatus: lastNavigationStatus, checkpoint };
}

export async function captureBrowserScreenshot() {
    if (!page || page.isClosed()) throw new Error('Browser page is not available');
    return page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
}

export async function submitCampaign(campaignId, actionId, routerTree, deploymentId) {
    await startPersistentBrowser();
    await seedAuthCookies();

    const currentHtml = await page.content().catch(() => '');
    if (checkpointDetected || lastNavigationStatus === 403 || checkpointPattern.test(currentHtml)) {
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

    if (result.status === 403 || checkpointPattern.test(result.body || '')) {
        checkpointDetected = true;
        log('browser submission received HTTP 403 or a checkpoint response; future saves are blocked');
    } else if (result.status === 429) {
        log('browser submission received HTTP 429 rate limit');
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
