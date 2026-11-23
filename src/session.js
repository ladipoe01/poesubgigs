import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const jar = new Map();

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
        const tmp = `${config.statePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
            session: store.session,
            actionId: store.actionId,
            deploymentId: store.deploymentId,
            routerTree: store.routerTree,
            loginFails: store.loginFails,
            rotateFails: store.rotateFails
        }));
        try {
            if (fs.existsSync(config.statePath)) fs.rmSync(config.statePath, { force: true });
            fs.renameSync(tmp, config.statePath);
        } catch {
            fs.copyFileSync(tmp, config.statePath);
            fs.rmSync(tmp, { force: true });
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
    if (response.status !== 200 || !data.access_token || !data.refresh_token) return false;
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
}

export function isCheckpoint(text) {
    const blob = String(text || '').slice(0, 2500);
    return /vercel/i.test(blob) && /too many requests|security checkpoint|rate limit|just a moment/i.test(blob);
}
