import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const jar = new Map();
let refreshInFlight = null;

export const store = {
    session: null,
    actionId: config.actionId,
    deploymentId: config.deploymentId,
    routerTree: '',
    loginFails: 0,
    rotateFails: 0,
    rotateUntil: 0,
    persistError: ''
};

export function authCookieBase() {
    const ref = new URL(config.supabaseUrl).hostname.split('.')[0];
    return `sb-${ref}-auth-token`;
}

export function decodeBase64Url(text) {
    let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    if (b64.length % 4) b64 += '='.repeat(4 - (b64.length % 4));
    const bin = Buffer.from(b64, 'base64').toString('latin1');
    const bytes = Uint8Array.from(bin, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function encodeBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return Buffer.from(bin, 'latin1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function chunkCookie(name, value) {
    const limit = 3180;
    const encoded = encodeURIComponent(value);
    if (encoded.length <= limit) return [{ name, value }];

    const parts = [];
    let rest = encoded;
    while (rest.length > 0) {
        let piece = rest.slice(0, limit);
        const pct = piece.lastIndexOf('%');
        if (pct > limit - 3) piece = piece.slice(0, pct);
        while (piece.length > 0) {
            try {
                decodeURIComponent(piece);
                break;
            } catch {
                if (piece.length > 3 && piece.at(-3) === '%') piece = piece.slice(0, -3);
                else throw new Error('Could not split the auth cookie');
            }
        }
        if (!piece) throw new Error('Could not split the auth cookie');
        parts.push(decodeURIComponent(piece));
        rest = rest.slice(piece.length);
    }
    return parts.map((part, index) => ({ name: `${name}.${index}`, value: part }));
}

export function coerceSession(input) {
    if (!input) return null;
    if (typeof input === 'object') {
        const session = input.currentSession || input;
        return session && typeof session === 'object' && (session.access_token || session.refresh_token) ? session : null;
    }
    let raw = String(input).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        try { raw = JSON.parse(raw); } catch { raw = raw.slice(1, -1); }
    }
    if (typeof raw !== 'string') return raw && raw.access_token ? raw : null;
    if (raw.startsWith('base64-')) {
        try { raw = decodeBase64Url(raw.slice('base64-'.length)); }
        catch { return null; }
    }
    if (!raw.startsWith('{')) return null;
    try {
        const session = JSON.parse(raw);
        const value = session?.currentSession || session;
        return value && (value.access_token || value.refresh_token) ? value : null;
    } catch {
        return null;
    }
}

function sessionFromJar() {
    const names = [...jar.keys()].filter(name => /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/.test(name));
    if (!names.length) return null;
    const base = names[0].replace(/\.\d+$/, '');
    let raw = '';
    names
        .filter(name => name === base || name.startsWith(`${base}.`))
        .sort((a, b) => {
            const ai = a === base ? -1 : Number(a.slice(base.length + 1));
            const bi = b === base ? -1 : Number(b.slice(base.length + 1));
            return ai - bi;
        })
        .forEach(name => { raw += jar.get(name) || ''; });
    return coerceSession(raw);
}

export function persist() {
    try {
        fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
        const tmp = `${config.statePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
            session: store.session,
            actionId: store.actionId,
            deploymentId: store.deploymentId,
            routerTree: store.routerTree,
            loginFails: store.loginFails,
            rotateFails: store.rotateFails
        }), { mode: 0o600 });
        try {
            // Rename replaces the previous file atomically on the Railway Linux volume.
            fs.renameSync(tmp, config.statePath);
        } catch (error) {
            fs.rmSync(tmp, { force: true });
            throw error;
        }
        store.persistError = '';
    } catch (error) {
        if (store.persistError !== error.message) {
            store.persistError = error.message;
            log(`state file not saved: ${error.message}`);
        }
    }
}

export function applySession(session, options = {}) {
    store.session = session;
    const base = authCookieBase();
    for (const name of [...jar.keys()]) {
        if (name === base || name.startsWith(`${base}.`)) jar.delete(name);
    }
    const value = `base64-${encodeBase64Url(JSON.stringify(session))}`;
    for (const chunk of chunkCookie(base, value)) jar.set(chunk.name, chunk.value);
    if (options.persist !== false) persist();
}

export function loadState() {
    let fromFile = null;
    try {
        fromFile = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
    } catch {
        fromFile = null;
    }
    const fromEnv = coerceSession(config.sessionJson);
    if (config.sessionForce && fromEnv) {
        applySession(fromEnv);
        log('session loaded from SG_SESSION_JSON');
        return;
    }
    if (fromFile?.session?.refresh_token || fromFile?.session?.access_token) {
        store.actionId = fromFile.actionId || store.actionId;
        store.deploymentId = fromFile.deploymentId || store.deploymentId;
        store.routerTree = fromFile.routerTree || '';
        store.loginFails = Number(fromFile.loginFails) || 0;
        store.rotateFails = Number(fromFile.rotateFails) || 0;
        applySession(fromFile.session, { persist: false });
        log('session loaded from state file');
        return;
    }
    if (fromEnv) {
        applySession(fromEnv);
        log('session loaded from SG_SESSION_JSON');
        return;
    }
    if (config.refreshToken) {
        applySession({
            access_token: config.accessToken,
            refresh_token: config.refreshToken,
            expires_at: config.expiresAt || undefined,
            token_type: 'bearer'
        });
        log('session loaded from SG_REFRESH_TOKEN');
    }
}

export function expiryLeft(session = store.session) {
    if (!session) return null;
    let expMs = null;
    if (typeof session.expires_at === 'number') expMs = session.expires_at * 1000;
    else if (session.access_token) {
        try {
            const body = JSON.parse(decodeBase64Url(session.access_token.split('.')[1]));
            if (typeof body.exp === 'number') expMs = body.exp * 1000;
        } catch {
            expMs = null;
        }
    }
    return expMs == null ? null : expMs - Date.now();
}

export function userId() {
    const session = store.session;
    if (!session?.access_token) return '';
    try {
        const body = JSON.parse(decodeBase64Url(session.access_token.split('.')[1]));
        return typeof body.sub === 'string' ? body.sub : '';
    } catch {
        return '';
    }
}

export function accessToken() {
    return store.session?.access_token || '';
}

export function cookieHeader() {
    if (!jar.size) return '';
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function absorbCookies(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of list) {
        const first = line.split(';')[0];
        const eq = first.indexOf('=');
        if (eq < 1) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (/max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
    }
}

export function ingestAuthCookie() {
    const session = sessionFromJar();
    if (!session?.access_token && !session?.refresh_token) return null;
    applySession({ ...store.session, ...session });
    return store.session;
}

export async function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
        const session = store.session;
        if (!session?.refresh_token) return false;
        let response;
        try {
            response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: config.supabaseKey,
                    Authorization: `Bearer ${config.supabaseKey}`
                },
                body: JSON.stringify({ refresh_token: session.refresh_token }),
                signal: AbortSignal.timeout(8000)
            });
        } catch (error) {
            log(`session refresh failed: ${error.message}`);
            return false;
        }
        const data = await response.json().catch(() => ({}));
        if (response.status !== 200 || !data.access_token || !data.refresh_token) {
            log(`session refresh rejected: HTTP ${response.status}`);
            return false;
        }
        const expiresAt = data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : session.expires_at);
        applySession({
            ...session,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_in: data.expires_in,
            expires_at: expiresAt,
            token_type: data.token_type || session.token_type || 'bearer',
            user: data.user || session.user
        });
        return true;
    })();
    try {
        return await refreshInFlight;
    } finally {
        refreshInFlight = null;
    }
}

function attr(tag, name) {
    const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return match ? (match[2] ?? match[3] ?? match[4] ?? '') : null;
}

function decodeEntities(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

export function parseLoginForm(html) {
    const formMatch = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i);
    if (!formMatch) return null;
    const form = formMatch[0];
    const action = attr(form, 'action') || '/login';
    const inputs = [...form.matchAll(/<input\b[^>]*>/gi)].map(match => {
        const name = attr(match[0], 'name');
        if (!name) return null;
        return { name, value: decodeEntities(attr(match[0], 'value') || '') };
    }).filter(Boolean);

    let nextAction = '';
    const named = html.match(/\$ACTION_ID_([0-9a-f]{40,64})/i);
    if (named) nextAction = named[1];
    if (!nextAction) {
        for (const input of inputs) {
            if (!input.name.startsWith('$ACTION_') || !input.value.includes('id')) continue;
            try {
                const parsed = JSON.parse(input.value);
                if (parsed && typeof parsed.id === 'string') nextAction = parsed.id;
            } catch {
                // Hidden action fields are not always JSON.
            }
        }
    }
    return { action, inputs, nextAction, hasActionField: inputs.some(input => input.name.startsWith('$ACTION_')) };
}

export async function loginWithPassword(meta = {}) {
    if (!config.username || !config.password) return { ok: false, reason: 'missing' };
    const pageUrl = `${config.siteOrigin}/login`;
    let page;
    try {
        page = await fetch(pageUrl, {
            headers: {
                Accept: 'text/html',
                'User-Agent': config.userAgent
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        return { ok: false, reason: 'network', detail: error.message };
    }
    const html = await page.text();
    if (page.status === 429 || isCheckpoint(html)) return { ok: false, reason: 'challenge', status: page.status };

    const form = parseLoginForm(html);
    if (!form) return { ok: false, reason: 'no-form', status: page.status };

    const body = new FormData();
    let sawUser = false;
    let sawPass = false;
    for (const input of form.inputs) {
        if (input.name === 'username' || input.name === 'email') {
            body.append(input.name, config.username);
            sawUser = true;
        } else if (input.name === 'password') {
            body.append(input.name, config.password);
            sawPass = true;
        } else {
            body.append(input.name, input.value);
        }
    }
    if (!sawUser) body.append('username', config.username);
    if (!sawPass) body.append('password', config.password);

    const headers = {
        Accept: 'text/x-component, text/html',
        Origin: config.siteOrigin,
        Referer: pageUrl,
        'User-Agent': config.userAgent
    };
    const actionId = form.nextAction || meta.loginAction || '';
    if (actionId && !form.hasActionField) headers['next-action'] = actionId;
    if (meta.deploymentId || store.deploymentId) headers['x-deployment-id'] = meta.deploymentId || store.deploymentId;
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;

    let posted;
    try {
        posted = await fetch(new URL(form.action || '/login', config.siteOrigin), {
            method: 'POST',
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        return { ok: false, reason: 'network', detail: error.message };
    }

    absorbCookies(posted);
    let status = posted.status;
    let text = '';
    if (status >= 300 && status < 400 && posted.headers.get('location')) {
        let next = new URL(posted.headers.get('location'), config.siteOrigin).href;
        for (let hop = 0; hop < 4; hop++) {
            const followHeaders = {
                Accept: 'text/html',
                'User-Agent': config.userAgent
            };
            const followCookie = cookieHeader();
            if (followCookie) followHeaders.Cookie = followCookie;
            const follow = await fetch(next, {
                headers: followHeaders,
                redirect: 'manual',
                signal: AbortSignal.timeout(15000)
            });
            absorbCookies(follow);
            status = follow.status;
            if (status >= 300 && status < 400 && follow.headers.get('location')) {
                next = new URL(follow.headers.get('location'), next).href;
                continue;
            }
            text = await follow.text();
            break;
        }
    } else {
        text = await posted.text();
    }

    if (isCheckpoint(text) || status === 429) return { ok: false, reason: 'challenge', status };
    const session = ingestAuthCookie();
    if (session?.access_token || session?.refresh_token) {
        store.loginFails = 0;
        store.rotateFails = 0;
        persist();
        return { ok: true };
    }
    if (/invalid|incorrect|wrong password|no user|not found/i.test(text)) {
        return { ok: false, reason: 'rejected', status };
    }
    return { ok: false, reason: 'no-session', status };
}

export function isCheckpoint(text) {
    const blob = String(text || '').slice(0, 2500);
    return /vercel/i.test(blob) && /too many requests|security checkpoint|rate limit|just a moment/i.test(blob);
}
