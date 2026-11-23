import { chromium } from 'playwright';
import { config } from './config.js';
import { applySession, coerceSession } from './session.js';
import { log } from './log.js';

let context;
let page;
let starting;
let loginInFlight;

const checkpointPattern = /security checkpoint|verify you are human|checking your browser|vercel security|challenge-platform/i;

function sessionFromCookieValue(value) {
    try {
        const decoded = decodeURIComponent(value);
        return coerceSession(decoded);
    } catch {
        return coerceSession(value);
    }
}

async function readBrowserSession() {
    if (!context || !page) return false;
    const cookies = await context.cookies(config.siteOrigin);
    const groups = new Map();
    for (const cookie of cookies) {
        if (!/^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/.test(cookie.name)) continue;
        const base = cookie.name.replace(/\.\d+$/, '');
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base).push(cookie);
    }
    for (const [base, parts] of groups) {
        parts.sort((a, b) => {
            const ai = a.name === base ? -1 : Number(a.name.slice(base.length + 1));
            const bi = b.name === base ? -1 : Number(b.name.slice(base.length + 1));
            return ai - bi;
        });
        const session = sessionFromCookieValue(parts.map(item => item.value).join(''));
        if (session?.refresh_token || session?.access_token) {
            applySession(session);
            return true;
        }
    }
    const local = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && /^sb-[a-z0-9]+-auth-token$/.test(key)) return localStorage.getItem(key);
        }
        return null;
    }).catch(() => null);
    if (local) {
        const session = sessionFromCookieValue(local);
        if (session?.refresh_token || session?.access_token) {
            applySession(session);
            return true;
        }
    }
    return false;
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
        try {
            const response = await page.goto(`${config.siteOrigin}/campaigns`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            const html = await page.content().catch(() => '');
            if (response?.status() === 429 || checkpointPattern.test(html)) {
                log('Vercel checkpoint detected in persistent browser; waiting for the site to allow access');
            } else {
                log('persistent browser profile ready');
            }
            await readBrowserSession();
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

export async function loginWithBrowser(force = false) {
    if (!config.username || !config.password) return { ok: false, reason: 'missing-credentials' };
    if (loginInFlight) return loginInFlight;
    loginInFlight = (async () => {
        try {
            await startPersistentBrowser();
            if (!force && await readBrowserSession()) return { ok: true, reason: 'existing-session' };
            await page.goto(`${config.siteOrigin}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
            const html = await page.content().catch(() => '');
            if (checkpointPattern.test(html)) return { ok: false, reason: 'checkpoint' };

            const username = page.locator('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]').first();
            const password = page.locator('input[type="password"]').first();
            if (!(await username.count()) || !(await password.count())) {
                return { ok: false, reason: 'login-form-not-found' };
            }
            await username.fill(config.username);
            await password.fill(config.password);
            const submit = page.getByRole('button', { name: /log in|login|sign in/i }).first();
            if (await submit.count()) await submit.click();
            else await password.press('Enter');

            await page.waitForTimeout(1800);
            await page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {});
            if (await readBrowserSession()) {
                log('automatic browser login successful; authenticated browser profile persisted');
                return { ok: true };
            }
            const after = await page.content().catch(() => '');
            if (checkpointPattern.test(after)) return { ok: false, reason: 'checkpoint' };
            if (/invalid credentials|incorrect password|invalid login|email or password/i.test(after)) {
                return { ok: false, reason: 'credentials-rejected' };
            }
            return { ok: false, reason: 'session-not-detected' };
        } catch (error) {
            log(`browser login failed: ${error.message}`);
            return { ok: false, reason: 'browser-error' };
        }
    })();
    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
    }
}

export async function captureBrowserScreenshot() {
    if (!page) await startPersistentBrowser();
    if (!page) throw new Error('Persistent browser page is unavailable');
    return page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
}

export async function submitCampaign(campaignId) {
    return {
        status: 501,
        url: page?.url() || config.siteOrigin,
        headers: { get() { return null; }, getSetCookie() { return []; } },
        async text() { return 'Save requests are disabled in this monitor-only build.'; }
    };
}

export async function closePersistentBrowser() {
    if (!context) return;
    const active = context;
    context = null;
    page = null;
    await active.close().catch(() => {});
}
