// ==UserScript==
// @name         SubsGigs Auto Save Engine v19.2.2 (Active Hold Hunter)
// @namespace    https://subsgigs-alpha.vercel.app/
// @version      19.2.2
// @description  150ms Web Worker capacity polling, instant single-ID live verification, baseline deduplication, calibrated server clock, and zero-lookup RSC Flight saves.
// @match        https://subsgigs-alpha.vercel.app/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(() => {
    'use strict';

    // ==========================================
    // 0. REACT HYDRATION ERROR SUPPRESSOR
    // ==========================================
    const origError = console.error;
    console.error = function (...args) {
        if (typeof args[0] === 'string' && args[0].includes('Minified React error #418')) return;
        origError.apply(console, args);
    };

    // ==========================================
    // 1. CONFIGURATION & CREDENTIALS
    // ==========================================
    const CONFIG = {
        fastPollMs: 150,
        liveSyncMs: 15000,
        fullRetryMs: 1500,
        recatchDelayMs: 0,
        armTickMs: 5,
        armLeadMinMs: 40,
        armLeadMaxMs: 1500,
        harvestMs: 300,
        absentMs: 1200,
        maintenanceInterval: 10 * 60 * 1000,
        maxPostsPerHourPerCampaign: 8,

        renewBelowMs: 8 * 60 * 1000,
        dangerBelowMs: 130 * 1000,
        deferRenewWindowMs: 60 * 1000,

        vercelWaitMs: 60 * 1000,
        vercelWaitMaxMs: 5 * 60 * 1000,

        supabaseUrl: 'https://kemvnhqbfaztwyhcerqh.supabase.co',
        supabaseKey: 'sb_publishable_p1bpyo6pXEiVtXTVso4W_A_XYfLmOqv',

        defaultActionId: '60609598ef4dce85b16c4600c68a34b1019243ba7d',
        defaultDeploymentId: 'dpl_8qiPBTT3XeZX3yPHRR2bp53oQwEs',
        releaseActionId: '60d25657a57fc749794da54b3529b1bd845cfb1a49',

        telegram: {
            enabled: true,
            botToken: gmGet('sg_telegram_token', ''),
            chatId: '6744846315'
        }
    };

    const CARD_SELECTOR = 'article, [class*="card"], [class*="Campaign"]';
    const ID_RE = /\/campaigns\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

    const claimed = new Set();
    const claimedUntil = new Map();
    const holdBridge = new Map();
    let reservationsReady = false;
    let userHasPriority = false;

    const liveIds = new Set();
    const deadIds = new Map();
    const verifyingIds = new Set();
    let liveIdsReady = false;

    const alreadyOpen = new Set();
    const timingKnown = new Set();
    const timingLoading = new Map();
    const unavailable = new Set();
    const holdingFull = new Set();
    const sawEmpty = new Set();
    const fullSince = new Map();
    const recatchArmed = new Set();
    const optimisticTried = new Set();
    const notifiedActive = new Set();
    const notifiedPriority = new Set();
    const saveInflight = new Set();
    const apiWarned = new Set();
    const windows = new Map();
    const pursuing = new Set();
    const sentThisOpen = new Set();
    const needRateRetry = new Set();
    const rateRetried = new Set();
    const absentSince = new Map();
    const postLedger = new Map();

    let openIds = new Set();
    let activeHeldSpots = 0;
    let baselineReady = false;
    let capacityRunning = false;
    let useMinimalCapacitySelect = false;
    let lastArmLabel = '';

    let workerActive = false;
    let lastCapacityAt = 0;
    let lastResSyncAt = 0;
    let lastLiveSyncAt = 0;
    let lastSessionEvalAt = 0;

    let vercelPauseUntil = 0;
    let vercelBackoffMs = CONFIG.vercelWaitMs;
    let vercelTold = false;
    let rateTimer = 0;

    let hud = null;
    let pendingHud = null;
    let lastLatency = '--';
    let lastLatencyMs = Number(gmGet('sg_last_latency_ms', '0')) || 0;
    let oneWaySamples = [];
    let serverClockOffsetMs = 0;
    let clockCalibrated = false;

    let sessionPause = false;
    let triedReset = false;
    let loginNavStarted = false;

    let liveAction = gmGet('sg_live_action', '') || CONFIG.defaultActionId;
    let seenTree = '';
    let seenDeployment = '';
    let chunkScanDone = false;

    // ==========================================
    // 2. CLOCK & TRANSIT CALIBRATION
    // ==========================================
    function serverNow() {
        return Date.now() + serverClockOffsetMs;
    }

    function updateClockFromResponse(response, reqStartPerf) {
        try {
            const dateStr = response && response.headers && response.headers.get('date');
            if (!dateStr) return;
            const serverHeaderMs = Date.parse(dateStr);
            if (!Number.isFinite(serverHeaderMs)) return;
            const rtt = Math.max(0, performance.now() - reqStartPerf);
            const estimatedServerNow = serverHeaderMs + 500 + (rtt / 2);
            const sampleOffset = estimatedServerNow - Date.now();
            if (!clockCalibrated) {
                serverClockOffsetMs = sampleOffset;
                clockCalibrated = true;
            } else {
                serverClockOffsetMs = Math.round(serverClockOffsetMs * 0.7 + sampleOffset * 0.3);
            }
        } catch (e) {}
    }

    function recordFlightMs(rttMs) {
        if (!Number.isFinite(rttMs) || rttMs <= 0) return;
        lastLatencyMs = rttMs;
        lastLatency = rttMs.toFixed(1);
        gmSet('sg_last_latency_ms', String(Math.round(rttMs)));
        const oneWay = Math.round(rttMs * 0.48);
        oneWaySamples.push(oneWay);
        if (oneWaySamples.length > 12) oneWaySamples.shift();
    }

    function armLeadMs() {
        if (!clockCalibrated) return CONFIG.armLeadMinMs;
        let estOneWay = lastLatencyMs ? Math.round(lastLatencyMs * 0.48) : CONFIG.armLeadMinMs;
        if (oneWaySamples.length >= 2) {
            const sorted = [...oneWaySamples].sort((a, b) => a - b);
            estOneWay = sorted[Math.floor(sorted.length * 0.35)];
        }
        return Math.max(CONFIG.armLeadMinMs, Math.min(CONFIG.armLeadMaxMs, estOneWay));
    }

    function canPostNow(campaignId) {
        const now = Date.now();
        const cutoff = now - 3600 * 1000;
        const times = (postLedger.get(campaignId) || []).filter(t => t > cutoff);
        postLedger.set(campaignId, times);
        return times.length < CONFIG.maxPostsPerHourPerCampaign;
    }

    function recordPostLedger(campaignId) {
        const now = Date.now();
        const cutoff = now - 3600 * 1000;
        const times = (postLedger.get(campaignId) || []).filter(t => t > cutoff);
        times.push(now);
        postLedger.set(campaignId, times);
    }

    // ==========================================
    // 3. TELEGRAM & NOTIFICATIONS
    // ==========================================
    function sendTelegramAlert(message, done) {
        const finish = status => { if (typeof done === 'function') done(status); };
        if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
            finish(0);
            return;
        }
        const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
        const payload = JSON.stringify({
            chat_id: CONFIG.telegram.chatId,
            text: message,
            parse_mode: 'HTML'
        });

        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'Content-Type': 'application/json' },
                data: payload,
                timeout: 8000,
                onload: r => finish(r.status),
                onerror: () => finish(0),
                ontimeout: () => finish(0)
            });
        } else {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).then(r => finish(r.status)).catch(() => finish(0));
        }
    }

    function desktopNotice(title, text) {
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({ title, text, timeout: 4000, highlight: true });
            }
        } catch (e) {}
    }

    function signalSave(campaignId) {
        if (notifiedActive.has(campaignId)) return;
        notifiedActive.add(campaignId);
        const info = windows.get(campaignId);
        sendTelegramAlert(info
            ? `<b>🔥 PRIORITY SPOT OPEN</b>\n\n<code>${campaignId}</code>\nSave fired (lead ${armLeadMs()}ms).`
            : `<b>🚨 SPOT OPEN</b>\n\n<code>${campaignId}</code>\nSave fired.`);
        desktopNotice(info ? 'Priority spot — save fired' : 'Spot open — save fired', campaignId);
    }

    // ==========================================
    // 4. AUDIO
    // ==========================================
    let audioCtx = null;

    function playSuccessChime() {
        try {
            if (!audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return;
                audioCtx = new AudioContextClass();
            }
            if (audioCtx.state === 'suspended') audioCtx.resume();

            const now = audioCtx.currentTime;
            const osc1 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            osc1.type = 'square';
            osc1.frequency.setValueAtTime(880, now);
            gain1.gain.setValueAtTime(0.5, now);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
            osc1.connect(gain1);
            gain1.connect(audioCtx.destination);
            osc1.start(now);
            osc1.stop(now + 0.2);

            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(1760, now + 0.1);
            gain2.gain.setValueAtTime(0.6, now + 0.1);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.start(now + 0.1);
            osc2.stop(now + 0.45);
        } catch (e) {}
    }

    // ==========================================
    // 5. DOM & STORAGE HELPERS
    // ==========================================
    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
        } catch (e) {}
        return fallback;
    }

    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, value);
        } catch (e) {}
    }

    function getCampaignId(card) {
        try {
            const input = card.querySelector('input[name*="campaignId"]');
            if (input && input.value) return input.value.toLowerCase();
            const link = card.querySelector('a[href*="/campaigns/"]');
            if (link && link.href) {
                const match = link.href.match(ID_RE);
                return match ? match[1].toLowerCase() : null;
            }
        } catch (e) {}
        return null;
    }

    function isCampaignId(id) {
        return typeof id === 'string' && ID_RE.test(`/campaigns/${id}`);
    }

    function isSnagPage() {
        const heading = document.querySelector('h1');
        return !!(heading && /hit a snag/i.test(heading.textContent || ''));
    }

    function isLoginPage() {
        return location.pathname === '/login' || location.pathname.startsWith('/login/');
    }

    function siteBlocked() {
        const title = document.title || '';
        const text = document.body ? document.body.innerText : '';
        const blob = `${title}\n${text}`.slice(0, 2500);
        return /vercel/i.test(blob) && /too many requests|security checkpoint|rate limit|just a moment/i.test(blob);
    }

    function pageCampaignId() {
        const match = location.pathname.match(ID_RE);
        return match ? match[1].toLowerCase() : '';
    }

    // ==========================================
    // 6. RESERVATIONS, TIMING & RSC HARVEST
    // ==========================================
    function loadClaimed() {
        claimed.clear();
        claimedUntil.clear();
        holdBridge.clear();
        recatchArmed.clear();
        optimisticTried.clear();
    }

    function trackOwnHold(campaignId, expiresAtMs) {
        if (!campaignId || !Number.isFinite(expiresAtMs) || expiresAtMs <= serverNow()) return;
        const id = campaignId.toLowerCase();
        claimed.add(id);
        claimedUntil.set(id, expiresAtMs);
        windows.delete(id);
    }

    function rememberClaimed(campaignId) {
        if (!campaignId) return;
        const id = campaignId.toLowerCase();
        const bridge = serverNow() + 20000;
        claimed.add(id);
        holdBridge.set(id, bridge);
        claimedUntil.set(id, bridge);
        windows.delete(id);
        syncReservations();
    }

    function nextHoldLeft(now) {
        let until = null;
        claimedUntil.forEach(value => {
            if (until == null || value < until) until = value;
        });
        if (until == null) return null;
        return Math.max(0, until - now);
    }

    function releaseExpiredHolds() {
        const now = serverNow();
        const due = [];
        claimedUntil.forEach((until, id) => {
            if (until + (CONFIG.recatchDelayMs || 0) <= now) due.push(id);
        });
        if (!due.length) return;
        due.forEach(id => {
            claimedUntil.delete(id);
            claimed.delete(id);
            holdBridge.delete(id);
            alreadyOpen.delete(id);
            sentThisOpen.delete(id);
            rateRetried.delete(id);
            needRateRetry.delete(id);
            apiWarned.delete(id);
            recatchArmed.add(id);
            if (baselineReady) pursue(id, false);
        });
    }

    function noteWindow(campaignId, endsAt, hasPriority, precise) {
        if (!campaignId || !Number.isFinite(endsAt)) return;
        const id = campaignId.toLowerCase();
        const prev = windows.get(id);
        if (prev && prev.precise && !precise) return;
        windows.set(id, { endsAt, hasPriority: !!hasPriority, precise: !!precise });
        timingKnown.add(id);
        alreadyOpen.delete(id);

        const left = endsAt - serverNow();
        if (!hasPriority && left > 0 && !notifiedPriority.has(id)) {
            notifiedPriority.add(id);
            const secs = Math.max(0, Math.ceil(left / 1000));
            sendTelegramAlert(`<b>🔥 PRIORITY COUNTDOWN</b>\n\n<code>${id}</code>\nPublic save opens in ${secs}s.`);
        }
        if (hasPriority && openIds.has(id)) consider(id);
    }

    function publicWait(campaignId) {
        const info = windows.get(campaignId);
        if (!info || info.hasPriority) return false;
        return (info.endsAt - serverNow()) > armLeadMs();
    }

    function harvestRscTimings() {
        if (!document.documentElement) return;
        const html = document.documentElement.innerHTML;
        if (!html) return;

        const here = pageCampaignId();
        if (here) {
            deadIds.delete(here);
            liveIds.add(here);
            const endsMatch = html.match(/priorityWindowEndsAt\\?":\\?"(\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+)/);
            if (endsMatch) {
                const endsAt = Date.parse(endsMatch[1]);
                const hasPrio = /hasPriorityAccess\\?":\s*true/.test(html) || userHasPriority;
                if (Number.isFinite(endsAt)) noteWindow(here, endsAt, hasPrio, true);
            }
            const resMatch = html.match(/reservation\\?":\{[^}]*?expires_at\\?":\\?"(\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+)/);
            if (resMatch) {
                const exp = Date.parse(resMatch[1]);
                if (Number.isFinite(exp) && exp > serverNow()) {
                    trackOwnHold(here, exp);
                }
            }
        }

        const seenInHtml = new Set();
        let m;
        UUID_GLOBAL_RE.lastIndex = 0;
        while ((m = UUID_GLOBAL_RE.exec(html)) !== null) {
            const id = m[0].toLowerCase();
            if (seenInHtml.has(id)) continue;
            const slice = html.slice(Math.max(0, m.index - 200), m.index + 2500);
            const liveMatch = slice.match(/liveAt\\?":\\?"(\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+)/);
            const secsMatch = slice.match(/priorityAccessWindowSeconds\\?":(\d+)/);
            if (liveMatch && secsMatch) {
                seenInHtml.add(id);
                deadIds.delete(id);
                liveIds.add(id);
                if (!timingKnown.has(id)) {
                    const liveAt = Date.parse(liveMatch[1]);
                    const secs = Number(secsMatch[1]);
                    if (Number.isFinite(liveAt)) {
                        timingKnown.add(id);
                        if (secs > 0) {
                            const endsAt = liveAt + secs * 1000;
                            if (endsAt > serverNow()) {
                                noteWindow(id, endsAt, !!userHasPriority, true);
                            }
                        }
                    }
                }
            }
        }
    }

    async function learnTiming(campaignId) {
        if (!campaignId || timingKnown.has(campaignId) || timingLoading.has(campaignId)) return;
        harvestRscTimings();
        if (timingKnown.has(campaignId)) return;

        timingLoading.set(campaignId, true);
        try {
            const rows = await supabaseGet(`/rest/v1/campaigns?select=status,live_at,priority_access_window_seconds&id=eq.${campaignId}&limit=1`);
            timingKnown.add(campaignId);
            if (rows && rows[0]) {
                if (rows[0].status && rows[0].status !== 'live') {
                    unavailable.add(campaignId);
                    liveIds.delete(campaignId);
                    deadIds.set(campaignId, Date.now());
                    return;
                }
                const liveAt = Date.parse(rows[0].live_at);
                const secs = Number(rows[0].priority_access_window_seconds) || 0;
                if (Number.isFinite(liveAt) && secs > 0) {
                    const endsAt = liveAt + secs * 1000;
                    if (endsAt > serverNow()) {
                        noteWindow(campaignId, endsAt, !!userHasPriority, true);
                    }
                }
            }
        } finally {
            timingLoading.delete(campaignId);
        }
    }

    async function verifyLiveCampaign(campaignId, hadOpenSpots) {
        const id = String(campaignId || '').toLowerCase();
        if (!isCampaignId(id) || liveIds.has(id) || verifyingIds.has(id)) return;
        const deadCheckedAt = deadIds.get(id);
        if (deadCheckedAt && Date.now() - deadCheckedAt < CONFIG.liveSyncMs) return;

        verifyingIds.add(id);
        try {
            const rows = await supabaseGet(`/rest/v1/campaigns?select=id,status,live_at,priority_access_window_seconds&id=eq.${id}&limit=1`);
            if (!rows) return;
            const row = rows[0];
            if (!row || row.status !== 'live') {
                deadIds.set(id, Date.now());
                liveIds.delete(id);
                unavailable.add(id);
                return;
            }

            deadIds.delete(id);
            liveIds.add(id);
            timingKnown.add(id);

            const liveAt = Date.parse(row.live_at);
            const secs = Number(row.priority_access_window_seconds) || 0;
            if (Number.isFinite(liveAt) && secs > 0) {
                const endsAt = liveAt + secs * 1000;
                if (endsAt > serverNow()) {
                    noteWindow(id, endsAt, !!userHasPriority, true);
                }
            }

            if (hadOpenSpots) {
                openIds.add(id);
                absentSince.delete(id);
            }
            if (openIds.has(id) && !sessionPause && !isSnagPage() && Date.now() >= vercelPauseUntil) {
                consider(id);
            }
        } finally {
            verifyingIds.delete(id);
        }
    }

    // ==========================================
    // 7. BUILD METADATA AUTO-DISCOVERY
    // ==========================================
    async function discoverBuildMetadata() {
        if (chunkScanDone) return;
        try {
            const dplAttr = document.documentElement?.getAttribute('data-dpl-id') ||
                            document.documentElement?.getAttribute('data-deployment-id');
            if (dplAttr) seenDeployment = dplAttr;

            const scripts = [...document.querySelectorAll('script[src*="/_next/static/"]')];
            if (!scripts.length) return;
            chunkScanDone = true;

            for (const s of scripts) {
                const src = s.src || '';
                if (!seenDeployment) {
                    const dplMatch = src.match(/[?&]dpl=([^&]+)/);
                    if (dplMatch) seenDeployment = decodeURIComponent(dplMatch[1]);
                }
                if (/turbopack|2nykiepra|27jktro|0cz1d0m/.test(src)) continue;
                fetch(src, { cache: 'force-cache' })
                    .then(r => r.ok ? r.text() : '')
                    .then(code => {
                        if (!code) return;
                        const match = code.match(/createServerReference\)\("([0-9a-f]{40})"[^)]{0,120}"reserveCampaignSpot"\)/);
                        if (match && match[1] && match[1] !== liveAction) {
                            liveAction = match[1];
                            gmSet('sg_live_action', liveAction);
                        }
                    })
                    .catch(() => {});
            }
        } catch (e) {}
    }

    // ==========================================
    // 8. SESSION RENEW + AUTO LOGIN
    // ==========================================
    function cookieJar() {
        const jar = new Map();
        const parts = document.cookie ? document.cookie.split('; ') : [];
        for (let i = 0; i < parts.length; i++) {
            const eq = parts[i].indexOf('=');
            if (eq < 1) continue;
            const name = parts[i].slice(0, eq);
            let value = parts[i].slice(eq + 1);
            try { value = decodeURIComponent(value); } catch (e) {}
            jar.set(name, value);
        }
        return jar;
    }

    function authCookieBase() {
        for (const name of cookieJar().keys()) {
            const match = name.match(/^(sb-[a-z0-9]+-auth-token)(?:\.\d+)?$/);
            if (match) return match[1];
        }
        return 'sb-kemvnhqbfaztwyhcerqh-auth-token';
    }

    function decodeBase64Url(text) {
        let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        if (b64.length % 4) b64 += '='.repeat(4 - (b64.length % 4));
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    function encodeBase64Url(text) {
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function readSession() {
        const jar = cookieJar();
        const names = [...jar.keys()].filter(name => /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/.test(name));
        if (!names.length) return null;

        const base = names[0].replace(/\.\d+$/, '');
        let raw = '';
        names
            .filter(name => name === base || name.startsWith(base + '.'))
            .sort((a, b) => {
                const ai = a === base ? -1 : Number(a.slice(base.length + 1));
                const bi = b === base ? -1 : Number(b.slice(base.length + 1));
                return ai - bi;
            })
            .forEach(name => { raw += jar.get(name) || ''; });

        if (!raw) return null;
        if (raw.startsWith('base64-')) {
            try { raw = decodeBase64Url(raw.slice('base64-'.length)); }
            catch (e) { return null; }
        }
        try { return JSON.parse(raw); }
        catch (e) { return null; }
    }

    function publicSupabaseHeaders() {
        return {
            apikey: CONFIG.supabaseKey,
            Authorization: `Bearer ${CONFIG.supabaseKey}`,
            Accept: 'application/json'
        };
    }

    function expiryLeft(session) {
        if (!session) return null;
        let expMs = null;
        if (typeof session.expires_at === 'number') expMs = session.expires_at * 1000;
        else if (session.access_token) {
            try {
                const body = JSON.parse(decodeBase64Url(session.access_token.split('.')[1]));
                if (typeof body.exp === 'number') expMs = body.exp * 1000;
            } catch (e) {}
        }
        return expMs == null ? null : expMs - Date.now();
    }

    function userId() {
        const session = readSession();
        if (!session || !session.access_token) return '';
        try {
            const body = JSON.parse(decodeBase64Url(session.access_token.split('.')[1]));
            return typeof body.sub === 'string' ? body.sub : '';
        } catch (e) {
            return '';
        }
    }

    function supabaseGet(path) {
        const session = readSession();
        const token = session && session.access_token;
        const headers = token
            ? { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${token}`, Accept: 'application/json' }
            : publicSupabaseHeaders();
        const t0 = performance.now();
        return fetch(`${CONFIG.supabaseUrl}${path}`, {
            cache: 'no-store',
            headers
        }).then(async response => {
            updateClockFromResponse(response, t0);
            if (!response.ok) return null;
            const data = await response.json();
            return Array.isArray(data) ? data : null;
        }).catch(() => null);
    }

    async function syncLiveCampaigns() {
        const rows = await supabaseGet('/rest/v1/campaigns?select=id&status=eq.live');
        if (!rows) return;
        const nextLive = new Set();
        rows.forEach(r => {
            if (r && isCampaignId(r.id)) {
                const id = r.id.toLowerCase();
                nextLive.add(id);
                deadIds.delete(id);
                unavailable.delete(id);
            }
        });
        const here = pageCampaignId();
        if (here) {
            nextLive.add(here);
            deadIds.delete(here);
        }
        liveIds.clear();
        nextLive.forEach(id => liveIds.add(id));
        liveIdsReady = true;
    }

    async function syncProfile() {
        const me = userId();
        const path = me
            ? `/rest/v1/profiles?select=has_priority_access&id=eq.${me}&limit=1`
            : '/rest/v1/profiles?select=has_priority_access&limit=1';
        const rows = await supabaseGet(path);
        if (rows && rows[0]) userHasPriority = !!rows[0].has_priority_access;
    }

    let reservationSyncing = false;

    async function syncReservations() {
        if (reservationSyncing) return;
        reservationSyncing = true;
        try {
            const me = userId();
            const rows = await supabaseGet('/rest/v1/campaign_spot_reservations?select=campaign_id,profile_id,expires_at,released_at&released_at=is.null');
            if (!rows) return;
            const now = serverNow();
            const next = new Map();
            rows.forEach(row => {
                if (!row || !isCampaignId(row.campaign_id) || row.released_at) return;
                if (me && row.profile_id && row.profile_id !== me) return;
                const until = Date.parse(row.expires_at);
                if (!Number.isFinite(until) || until <= now) return;
                next.set(row.campaign_id.toLowerCase(), until);
            });
            const dropped = [];
            claimedUntil.forEach((until, id) => {
                if (next.has(id)) return;
                if ((holdBridge.get(id) || 0) > now) {
                    next.set(id, until);
                    return;
                }
                dropped.push(id);
            });
            claimed.clear();
            claimedUntil.clear();
            next.forEach((until, id) => {
                claimed.add(id);
                claimedUntil.set(id, until);
                if ((holdBridge.get(id) || 0) <= now) holdBridge.delete(id);
            });
            dropped.forEach(id => {
                claimed.delete(id);
                alreadyOpen.delete(id);
                sentThisOpen.delete(id);
                rateRetried.delete(id);
                needRateRetry.delete(id);
                apiWarned.delete(id);
                holdBridge.delete(id);
                recatchArmed.add(id);
                if (baselineReady) pursue(id, false);
            });
        } finally {
            reservationSyncing = false;
            reservationsReady = true;
        }
    }

    function chunkCookie(name, value) {
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
                } catch (e) {
                    if (piece.length > 3 && piece.at(-3) === '%') piece = piece.slice(0, -3);
                    else throw e;
                }
            }
            parts.push(decodeURIComponent(piece));
            rest = rest.slice(piece.length);
        }
        return parts.map((part, index) => ({ name: `${name}.${index}`, value: part }));
    }

    function writeSession(session) {
        const base = authCookieBase();
        const value = 'base64-' + encodeBase64Url(JSON.stringify(session));
        const chunks = chunkCookie(base, value);
        const keep = new Set(chunks.map(chunk => chunk.name));
        const maxAge = 34560000;

        for (const name of cookieJar().keys()) {
            if ((name === base || name.startsWith(base + '.')) && !keep.has(name)) {
                document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
            }
        }
        for (const chunk of chunks) {
            document.cookie = `${chunk.name}=${encodeURIComponent(chunk.value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
        }
    }

    function rotateSession(session) {
        return new Promise(resolve => {
            if (!session || !session.refresh_token || typeof GM_xmlhttpRequest !== 'function') {
                resolve(false);
                return;
            }
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
                headers: {
                    'Content-Type': 'application/json',
                    apikey: CONFIG.supabaseKey,
                    Authorization: `Bearer ${CONFIG.supabaseKey}`
                },
                data: JSON.stringify({ refresh_token: session.refresh_token }),
                timeout: 8000,
                onload(response) {
                    try {
                        const data = JSON.parse(response.responseText || '{}');
                        if (response.status !== 200 || !data.access_token || !data.refresh_token) {
                            resolve(false);
                            return;
                        }
                        writeSession({
                            ...session,
                            access_token: data.access_token,
                            refresh_token: data.refresh_token,
                            expires_in: data.expires_in,
                            expires_at: data.expires_at,
                            token_type: data.token_type || session.token_type || 'bearer',
                            user: data.user || session.user
                        });
                        resolve(true);
                    } catch (e) {
                        resolve(false);
                    }
                },
                onerror() { resolve(false); },
                ontimeout() { resolve(false); }
            });
        });
    }

    function scheduleRotate(session, recover) {
        const until = Number(gmGet('sg_rotate_until', 0));
        if (Date.now() < until) return;
        gmSet('sg_rotate_until', Date.now() + 8000);
        setHud(recover ? 'RENEWING AFTER SNAG' : 'RENEWING LOGIN');

        rotateSession(session).then(ok => {
            if (ok) {
                gmSet('sg_rotate_fails', 0);
                gmSet('sg_rotate_until', Date.now() + 20 * 60 * 1000);
                gmSet('sg_was_in', 1);
                sessionPause = false;
                setHud('LOGIN RENEWED');
                return;
            }

            const fails = Number(gmGet('sg_rotate_fails', 0)) + 1;
            gmSet('sg_rotate_fails', fails);
            gmSet('sg_rotate_until', 0);
            const left = expiryLeft(readSession());
            if (recover || fails >= 2 || left == null || left <= CONFIG.dangerBelowMs) goLogin();
        });
    }

    function savedLogin() {
        return {
            username: String(gmGet('sg_user', '') || '').trim().replace(/^@/, ''),
            password: String(gmGet('sg_pass', '') || '')
        };
    }

    function goLogin() {
        if (!gmGet('sg_auto', 1)) {
            pauseSaves('AUTO LOGIN PAUSED');
            return;
        }
        const creds = savedLogin();
        if (!creds.username || !creds.password) {
            pauseSaves('SET LOGIN IN MENU');
            sendTelegramAlert('<b>⚠️ SESSION DOWN</b>\n\nOpen the userscript menu and choose <b>Save SubsGigs login</b> once.');
            return;
        }
        if (Number(gmGet('sg_login_fails', 0)) >= 3) {
            pauseSaves('LOGIN FAILED');
            return;
        }
        if (isLoginPage()) {
            armLogin();
            return;
        }
        if (loginNavStarted) return;
        loginNavStarted = true;
        pauseSaves('AUTO LOGIN');
        location.replace('/login');
    }

    function armLogin() {
        if (!gmGet('sg_auto', 1)) { setHud('AUTO LOGIN PAUSED'); return; }
        const creds = savedLogin();
        if (!creds.username || !creds.password) { setHud('SET LOGIN IN MENU'); return; }
        if (Number(gmGet('sg_login_fails', 0)) >= 3) { setHud('LOGIN FAILED'); return; }
        if (window.__sgLoginArmed) return;
        window.__sgLoginArmed = true;
        sessionPause = true;

        const trySubmit = () => {
            const form = document.querySelector('form');
            const user = form && form.querySelector('input[name="username"]');
            const pass = form && form.querySelector('input[name="password"]');
            if (!form || !user || !pass) return false;

            const alertBox = form.querySelector('[role="alert"]');
            if (alertBox && alertBox.textContent.trim()) {
                const fails = Number(gmGet('sg_login_fails', 0)) + 1;
                gmSet('sg_login_fails', fails);
                setHud(fails >= 3 ? 'LOGIN FAILED' : 'LOGIN REJECTED');
                return true;
            }

            const last = Number(gmGet('sg_login_at', 0));
            if (Date.now() - last < 4000) return true;

            user.value = creds.username;
            pass.value = creds.password;
            gmSet('sg_login_at', Date.now());
            setHud('AUTO LOGIN');
            form.submit();
            return true;
        };

        if (trySubmit()) return;
        const loginObserver = new MutationObserver(() => {
            if (trySubmit()) loginObserver.disconnect();
        });
        loginObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', () => trySubmit(), { once: true });
    }

    function pauseSaves(mode) {
        sessionPause = true;
        setHud(mode);
    }

    function hasImminentWindow() {
        const now = serverNow();
        for (const info of windows.values()) {
            if (!info.hasPriority && info.endsAt > now && (info.endsAt - now) <= CONFIG.deferRenewWindowMs) {
                return true;
            }
        }
        return false;
    }

    function evaluateSession() {
        if (isLoginPage()) {
            sessionPause = true;
            armLogin();
            return;
        }

        const session = readSession();
        const left = expiryLeft(session);

        if (session && left > CONFIG.renewBelowMs) {
            sessionPause = false;
            gmSet('sg_was_in', 1);
            gmSet('sg_rotate_fails', 0);
            gmSet('sg_login_fails', 0);
            return;
        }

        if (session && left > CONFIG.dangerBelowMs) {
            sessionPause = false;
            if (!hasImminentWindow()) scheduleRotate(session, false);
            return;
        }

        pauseSaves(session ? 'TOKEN RISK' : 'SIGNED OUT');

        if (session && session.refresh_token && Number(gmGet('sg_rotate_fails', 0)) < 2) {
            scheduleRotate(session, true);
            return;
        }

        if (gmGet('sg_was_in', 0) || savedLogin().username) goLogin();
    }

    function watchPage() {
        if (isLoginPage() || !isSnagPage()) return;

        const session = readSession();
        const left = expiryLeft(session);
        if (session && left > CONFIG.dangerBelowMs) {
            if (triedReset) return;
            triedReset = true;
            const button = [...document.querySelectorAll('button')]
                .find(node => /try again/i.test(node.textContent || ''));
            if (button) button.click();
            return;
        }

        pauseSaves('SNAG');
        if (Date.now() < Number(gmGet('sg_rotate_until', 0))) return;
        if (session && session.refresh_token && Number(gmGet('sg_rotate_fails', 0)) < 2) {
            scheduleRotate(session, true);
            return;
        }
        goLogin();
    }

    // ==========================================
    // 9. HUD
    // ==========================================
    function createHUD() {
        if (hud || !document.body) return;
        try {
            hud = document.createElement('div');
            hud.id = 'sg-v19-hud';
            Object.assign(hud.style, {
                position: 'fixed',
                top: '10px',
                right: '10px',
                zIndex: '999999',
                padding: '6px 12px',
                background: 'rgba(17, 24, 39, 0.95)',
                color: '#10B981',
                border: '1px solid #374151',
                borderRadius: '20px',
                font: '11px monospace',
                fontWeight: 'bold',
                pointerEvents: 'none',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(4px)'
            });
            document.body.appendChild(hud);
            renderHUD(pendingHud || 'WATCHING');
            pendingHud = null;
        } catch (e) {
            hud = null;
        }
    }

    function setHud(mode) {
        pendingHud = mode;
        if (document.body) renderHUD(mode);
    }

    function renderHUD(mode = 'WATCHING') {
        if (!hud) {
            createHUD();
            if (!hud) return;
        }

        if (mode.includes('FAILED') || mode.includes('SIGNED OUT') || mode.includes('VERCEL') || mode.includes('PAUSED')) {
            hud.style.borderColor = '#EF4444';
            hud.style.color = '#FCA5A5';
        } else if (mode.includes('CLAIMED') || mode.includes('RENEWED') || mode.includes('WATCHING')) {
            hud.style.borderColor = '#10B981';
            hud.style.color = '#10B981';
        } else if (
            mode.includes('RENEW') || mode.includes('LOGIN') || mode.includes('TOKEN') ||
            mode.includes('SNAG') || mode.includes('REJECTED') || mode.includes('ARMED') ||
            mode.includes('WAITING') || mode.includes('FULL') || mode.includes('HOLD') || mode.includes('HUNTING')
        ) {
            hud.style.borderColor = '#F59E0B';
            hud.style.color = '#FCD34D';
        } else if (mode.includes('SAVE SENT')) {
            hud.style.borderColor = '#10B981';
            hud.style.color = '#6EE7B7';
        } else {
            hud.style.borderColor = '#374151';
            hud.style.color = '#9CA3AF';
        }

        const bgTag = document.hidden ? ' [BG]' : '';
        hud.textContent = `SG v19.2.2 | ${mode}${bgTag} | LIVE: ${liveIds.size} | RTT: ${lastLatency}ms`;
    }

    function notifySuccess(id) {
        playSuccessChime();
        sendTelegramAlert(`<b>✅ SPOT CLAIMED!</b>\n\n<b>Campaign ID:</b> <code>${id}</code>\n<b>RTT:</b> ${lastLatency}ms | <b>Lead:</b> ${armLeadMs()}ms\n<b>Status:</b> Spot saved for 10 mins.`);
        desktopNotice('Spot saved', `Claimed spot for campaign: ${id}`);
    }

    function showArmLabel(label) {
        if (label === lastArmLabel) return;
        lastArmLabel = label;
        setHud(label);
    }

    // ==========================================
    // 10. DIRECT RSC FLIGHT SAVE
    // ==========================================
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function warnOnce(campaignId, message) {
        if (apiWarned.has(campaignId)) return;
        apiWarned.add(campaignId);
        sendTelegramAlert(message);
    }

    function listTree() {
        return ['', {
            children: ['(dashboard)', {
                children: ['campaigns', {
                    children: ['__PAGE__', {}, null, null, 0]
                }, null, null, 0]
            }, null, null, 4]
        }, null, null, 28];
    }

    function detailTree(campaignId) {
        return ['', {
            children: ['(dashboard)', {
                children: ['campaigns', {
                    children: [
                        ['campaignId', campaignId, 'd', null],
                        { children: ['__PAGE__', {}, null, null, 0] },
                        null,
                        null,
                        0
                    ]
                }, null, null, 0]
            }, null, null, 4]
        }, null, null, 28];
    }

    function routerTree(campaignId, detail) {
        if (seenTree) {
            let decoded = seenTree;
            try { decoded = decodeURIComponent(seenTree); } catch (e) {}
            const onThisCampaign = decoded.includes(campaignId);
            const onList = decoded.includes('__PAGE__') && !decoded.includes('campaignId');
            if (detail && onThisCampaign) return seenTree;
            if (!detail && onList) return seenTree;
        }
        return encodeURIComponent(JSON.stringify(detail ? detailTree(campaignId) : listTree()));
    }

    function currentDeployment() {
        if (seenDeployment) return seenDeployment;
        try {
            const attr = document.documentElement?.getAttribute('data-dpl-id') || document.documentElement?.getAttribute('data-deployment-id');
            if (attr) return attr;
            const node = document.querySelector('script[src*="dpl="],link[href*="dpl="]');
            const src = node ? (node.src || node.href || '') : '';
            const match = src.match(/[?&]dpl=([^&]+)/);
            if (match) return decodeURIComponent(match[1]);
        } catch (e) {}
        return CONFIG.defaultDeploymentId;
    }

    function notePageHeaders(headers) {
        if (!headers || typeof headers.forEach !== 'function') return;
        headers.forEach((value, key) => {
            const name = String(key || '').toLowerCase();
            if (name === 'next-router-state-tree' && value) seenTree = value;
            if (name === 'x-deployment-id' && value) seenDeployment = value;
            if (name === 'next-action' && value && value !== CONFIG.releaseActionId) {
                liveAction = value;
                gmSet('sg_live_action', liveAction);
            }
        });
    }

    function pageWindow() {
        return typeof unsafeWindow === 'object' && unsafeWindow ? unsafeWindow : window;
    }

    function pageFetch(url, init) {
        const page = pageWindow();
        return page.fetch.call(page, url, init);
    }

    function hookPageFetch() {
        const page = pageWindow();
        if (!page.fetch || page.fetch.__sgSave) return;
        const original = page.fetch;
        const hooked = function (input, init) {
            try {
                const headers = new page.Headers(input && input.headers);
                if (init && init.headers) new page.Headers(init.headers).forEach((value, key) => headers.set(key, value));
                notePageHeaders(headers);
            } catch (e) {}
            return original.apply(this, arguments);
        };
        hooked.__sgSave = true;
        page.fetch = hooked;
    }

    function buildPacket(campaignId) {
        const body = new (pageWindow().FormData)();
        body.append('_1_campaignId', String(campaignId));
        body.append('0', '[{},"$K1"]');
        return body;
    }

    function savedText(response, text) {
        if (!response) return false;
        if (/"success"\s*:\s*"Spot saved/i.test(text || '')) return true;
        if (response.headers.get('x-action-redirect') || response.headers.get('x-nextjs-redirect') || response.headers.get('location')) {
            return true;
        }
        return /spot saved|saved for|reservation confirmed|spot reserved|held for \d+ minute/i.test(text || '');
    }

    function noteVercelLimit() {
        if (Date.now() < vercelPauseUntil) return;
        const wait = vercelBackoffMs;
        vercelPauseUntil = Date.now() + wait;
        vercelBackoffMs = Math.min(vercelBackoffMs * 2, CONFIG.vercelWaitMaxMs);
        needRateRetry.clear();
        setHud(`PAUSED ${Math.ceil(wait / 1000)}s`);
        if (!vercelTold) {
            vercelTold = true;
            sendTelegramAlert(`<b>⏸ SAVES PAUSED</b>\n\nRate limit hit. Pausing for ${Math.ceil(wait / 1000)}s.`);
        }
    }

    function scheduleRateRetry(wait) {
        if (rateTimer) return;
        rateTimer = setTimeout(() => {
            rateTimer = 0;
            if (Date.now() < vercelPauseUntil) {
                scheduleRateRetry(Math.max(0, vercelPauseUntil - Date.now()));
                return;
            }
            vercelTold = false;
            if (sessionPause || isLoginPage() || isSnagPage()) return;
            const ids = [...needRateRetry];
            needRateRetry.clear();
            ids.forEach(id => {
                if (!openIds.has(id) || claimed.has(id) || unavailable.has(id) || holdingFull.has(id)) return;
                pursue(id, true);
            });
        }, wait + 40);
    }

    async function saveOnce(campaignId) {
        if (gmGet('sg_auto_saves_enabled', false) !== true) return 'wait';
        if (!isCampaignId(campaignId)) return 'full';
        if (sessionPause || isSnagPage() || isLoginPage() || publicWait(campaignId)) return 'wait';
        if (Date.now() < vercelPauseUntil) return 'wait';
        if (claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return 'full';
        if (saveInflight.has(campaignId)) return 'wait';
        if (!canPostNow(campaignId)) {
            warnOnce(campaignId, `<b>🛑 SAFETY CAP</b>\n\n<code>${campaignId}</code>\nReached ${CONFIG.maxPostsPerHourPerCampaign} POSTs/hr limit.`);
            return 'full';
        }

        const detail = pageCampaignId() === campaignId;
        const action = liveAction || CONFIG.defaultActionId;
        const body = buildPacket(campaignId);
        const beforePromise = spotsLeft(campaignId);

        saveInflight.add(campaignId);
        recordPostLedger(campaignId);
        const started = performance.now();

        const postedPromise = pageFetch(detail ? `${location.origin}/campaigns/${campaignId}` : `${location.origin}/campaigns`, {
            method: 'POST',
            body,
            headers: {
                Accept: 'text/x-component',
                'next-action': action,
                'next-router-state-tree': routerTree(campaignId, detail),
                'x-deployment-id': currentDeployment()
            },
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            priority: 'high',
            keepalive: true
        });

        signalSave(campaignId);
        setHud('SAVE SENT');

        try {
            const posted = await postedPromise;
            const rtt = performance.now() - started;
            updateClockFromResponse(posted, started);
            recordFlightMs(rtt);

            const text = await posted.text();
            const lower = text.toLowerCase();

            if (posted.status === 429 || posted.status === 502 || posted.status === 503 || /security checkpoint|too many requests/i.test(lower)) {
                noteVercelLimit();
                return 'rate';
            }

            if (String(posted.url || '').includes('/login') || lower.includes('sign in to subsgigs')) {
                goLogin();
                return 'login';
            }

            if (posted.headers.get('x-nextjs-action-not-found') === '1' || /server action .* was not found|e715/i.test(text)) {
                chunkScanDone = false;
                discoverBuildMetadata();
                return 'stale';
            }

            if (/priority access|open to everyone in|priority window/i.test(lower)) {
                const secMatch = text.match(/open to everyone in (\d+) seconds/i);
                if (secMatch) {
                    noteWindow(campaignId, serverNow() + Number(secMatch[1]) * 1000, false, false);
                }
                setHud('PRIORITY GATE');
                return 'wait';
            }

            if (/spot is full|no spots left|campaign full|no remaining spots|entry limit/.test(lower)) {
                markFull(campaignId);
                renderHUD('SPOT FULL');
                return 'full';
            }

            const before = await beforePromise;
            if (savedText(posted, text) || await countDropped(campaignId, before)) {
                finishSaved(campaignId);
                return 'saved';
            }

            const errMatch = text.match(/"error"\s*:\s*"([^"]+)"/);
            const alertText = errMatch ? errMatch[1] : '';
            if (alertText) {
                if (/priority access|open to everyone/i.test(alertText)) {
                    setHud('PRIORITY GATE');
                    return 'wait';
                }
                if (/spot is full|no spots left|campaign full|no remaining|entry limit/i.test(alertText)) {
                    markFull(campaignId);
                    renderHUD('SPOT FULL');
                    return 'full';
                }
                warnOnce(campaignId, `<b>⚠️ SAVE NOT ACCEPTED</b>\n\n<code>${campaignId}</code>\n${alertText}`);
                unavailable.add(campaignId);
                return 'full';
            }

            warnOnce(campaignId, `<b>⚠️ SAVE UNCONFIRMED</b>\n\n<code>${campaignId}</code>\nHTTP ${posted.status}. Spots before: ${before == null ? '?' : before}.\n<code>${replyClip(text) || 'empty reply'}</code>`);
            unavailable.add(campaignId);
            setHud('SAVE UNCONFIRMED');
            return 'full';
        } catch (e) {
            return 'retry';
        } finally {
            saveInflight.delete(campaignId);
        }
    }

    function finishSaved(campaignId) {
        rememberClaimed(campaignId);
        windows.delete(campaignId);
        holdingFull.delete(campaignId);
        fullSince.delete(campaignId);
        recatchArmed.delete(campaignId);
        sentThisOpen.delete(campaignId);
        vercelBackoffMs = CONFIG.vercelWaitMs;
        renderHUD('SPOT CLAIMED');
        notifySuccess(campaignId);
    }

    async function pursue(campaignId, extra) {
        if (claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return;
        if (sessionPause || isLoginPage() || isSnagPage() || publicWait(campaignId)) return;
        if (Date.now() < vercelPauseUntil) return;
        if (!openIds.has(campaignId) && !recatchArmed.has(campaignId)) return;

        if (extra) {
            if (rateRetried.has(campaignId)) return;
            rateRetried.add(campaignId);
        } else if (sentThisOpen.has(campaignId)) {
            return;
        }
        if (pursuing.has(campaignId)) return;

        sentThisOpen.add(campaignId);
        pursuing.add(campaignId);
        try {
            const result = await saveOnce(campaignId);
            if ((result === 'wait' || result === 'stale') && !extra) {
                sentThisOpen.delete(campaignId);
                return;
            }
            if (result === 'rate' && !extra) {
                needRateRetry.add(campaignId);
                scheduleRateRetry(Math.max(0, vercelPauseUntil - Date.now()));
            }
        } finally {
            pursuing.delete(campaignId);
        }
    }

    function consider(campaignId) {
        if (!campaignId || !baselineReady || !reservationsReady || !liveIdsReady || siteBlocked()) return;
        if (alreadyOpen.has(campaignId) || claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return;
        if (!liveIds.has(campaignId)) return;

        const countdownVisible = windows.has(campaignId);
        if (!timingKnown.has(campaignId)) {
            if (!timingLoading.has(campaignId)) {
                learnTiming(campaignId).then(() => {
                    if (optimisticTried.has(campaignId)) sentThisOpen.delete(campaignId);
                    consider(campaignId);
                });
            }
            if (!countdownVisible && !optimisticTried.has(campaignId) && openIds.has(campaignId)) {
                optimisticTried.add(campaignId);
                pursue(campaignId, false);
            }
            return;
        }

        if (publicWait(campaignId) || sessionPause || isSnagPage() || isLoginPage()) return;
        if (!openIds.has(campaignId) || Date.now() < vercelPauseUntil) return;
        pursue(campaignId, false);
    }

    function markFull(campaignId) {
        holdingFull.add(campaignId);
        fullSince.set(campaignId, Date.now());
        recatchArmed.delete(campaignId);
        sawEmpty.delete(campaignId);
        alreadyOpen.delete(campaignId);
        learnTiming(campaignId);
        warnOnce(campaignId, `<b>❌ SPOT FULL</b>\n\n<code>${campaignId}</code>\nWatching for released/expired spots.`);
    }

    function settle() {
        const now = Date.now();
        holdingFull.forEach(id => {
            if (openIds.has(id)) return;
            const since = absentSince.get(id);
            if (since && now - since >= 800) sawEmpty.add(id);
        });

        openIds.forEach(id => {
            if (!holdingFull.has(id) || !sawEmpty.has(id)) return;
            holdingFull.delete(id);
            sawEmpty.delete(id);
            fullSince.delete(id);
            sentThisOpen.delete(id);
            rateRetried.delete(id);
            needRateRetry.delete(id);
            apiWarned.delete(id);
            notifiedActive.delete(id);
        });

        openIds.forEach(id => {
            if (!holdingFull.has(id)) return;
            const since = fullSince.get(id);
            if (since == null || now - since < CONFIG.fullRetryMs) return;
            holdingFull.delete(id);
            sawEmpty.delete(id);
            fullSince.delete(id);
            sentThisOpen.delete(id);
            rateRetried.delete(id);
            needRateRetry.delete(id);
        });

        [...alreadyOpen].forEach(id => {
            if (openIds.has(id)) return;
            const since = absentSince.get(id);
            if (since && now - since >= 800) alreadyOpen.delete(id);
        });

        [...sentThisOpen].forEach(id => {
            if (openIds.has(id) || holdingFull.has(id)) return;
            const since = absentSince.get(id);
            if (since && now - since >= CONFIG.absentMs) {
                sentThisOpen.delete(id);
                rateRetried.delete(id);
                needRateRetry.delete(id);
                absentSince.delete(id);
            }
        });
    }

    function applyOpenSet(next) {
        const now = Date.now();
        openIds.forEach(id => {
            if (!next.has(id) && !absentSince.has(id)) absentSince.set(id, now);
        });
        next.forEach(id => absentSince.delete(id));
        openIds = next;
    }

    function takeBaseline(openNow) {
        if (baselineReady) return;
        openNow.forEach(id => {
            const info = windows.get(id);
            if (info && !info.hasPriority) return;
            alreadyOpen.add(id);
        });
        baselineReady = true;
    }

    // ==========================================
    // 11. SUPABASE CAPACITY POLL (LIVE-FILTERED)
    // ==========================================
    function spotsLeft(campaignId) {
        const url = `${CONFIG.supabaseUrl}/rest/v1/campaign_capacity?select=spots_left&campaign_id=eq.${campaignId}`;
        const t0 = performance.now();
        return fetch(url, {
            cache: 'no-store',
            headers: publicSupabaseHeaders()
        }).then(async response => {
            updateClockFromResponse(response, t0);
            if (!response.ok) return null;
            const rows = await response.json();
            if (!Array.isArray(rows) || !rows.length) return 0;
            const count = Number(rows[0].spots_left);
            return Number.isFinite(count) ? count : null;
        }).catch(() => null);
    }

    async function countDropped(campaignId, before) {
        if (before == null) return false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const now = await spotsLeft(campaignId);
            if (now != null && now < before) return true;
            if (attempt < 2) await sleep(250);
        }
        return false;
    }

    function replyClip(text) {
        return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    }

    function fetchLiveCapacities() {
        const query = useMinimalCapacitySelect
            ? 'select=campaign_id,spots_left&spots_left=gt.0'
            : 'select=campaign_id,spots_left,active_reservations';
        const url = `${CONFIG.supabaseUrl}/rest/v1/campaign_capacity?${query}`;
        const t0 = performance.now();
        return fetch(url, {
            cache: 'no-store',
            headers: publicSupabaseHeaders()
        }).then(async response => {
            updateClockFromResponse(response, t0);
            if (!response.ok) {
                if (response.status === 400 && !useMinimalCapacitySelect) {
                    useMinimalCapacitySelect = true;
                }
                return null;
            }
            const rows = await response.json();
            return Array.isArray(rows) ? rows : null;
        }).catch(() => null);
    }

    async function pollCapacity() {
        if (capacityRunning || isLoginPage() || !liveIdsReady) return;
        capacityRunning = true;
        try {
            const rows = await fetchLiveCapacities();
            if (!rows) return;

            const now = Date.now();
            const nextOpen = new Set();
            let heldOtherCount = 0;

            rows.forEach(row => {
                if (!row || !row.campaign_id) return;
                const id = row.campaign_id.toLowerCase();
                const deadCheckedAt = deadIds.get(id);
                if (deadCheckedAt) {
                    if (now - deadCheckedAt < CONFIG.liveSyncMs) return;
                    deadIds.delete(id);
                }

                const spots = Number(row.spots_left) || 0;
                const held = Number(row.active_reservations) || 0;

                if (!liveIds.has(id)) {
                    if (spots > 0 || held > 0) verifyLiveCampaign(id, spots > 0);
                    return;
                }

                if (spots > 0) {
                    nextOpen.add(id);
                } else if (held > 0 && !claimed.has(id)) {
                    heldOtherCount += held;
                }
            });

            activeHeldSpots = heldOtherCount;
            applyOpenSet(nextOpen);
            if (!baselineReady) takeBaseline(nextOpen);
            settle();

            if (sessionPause || isSnagPage() || Date.now() < vercelPauseUntil) return;

            openIds.forEach(id => consider(id));
            recatchArmed.forEach(id => {
                if (!liveIds.has(id) || claimed.has(id) || holdingFull.has(id) || pursuing.has(id)) return;
                sentThisOpen.delete(id);
                pursue(id, false);
            });
        } catch (e) {
        } finally {
            capacityRunning = false;
        }
    }

    function harvest() {
        if (isLoginPage()) return;
        discoverBuildMetadata();
        harvestRscTimings();

        if (!document.querySelectorAll) return;
        const cards = document.querySelectorAll(CARD_SELECTOR);
        for (let i = 0; i < cards.length; i++) {
            const id = getCampaignId(cards[i]);
            if (!id) continue;
            deadIds.delete(id);
            liveIds.add(id);
            const text = cards[i].innerText || '';
            const match = text.match(/open to everyone in (\d+) seconds/i);
            if (match) {
                noteWindow(id, serverNow() + Number(match[1]) * 1000, false, false);
                learnTiming(id);
            }
        }
    }

    // ==========================================
    // 12. BACKGROUND-IMMUNE WEB WORKER TICKER
    // ==========================================
    function armTick() {
        settle();
        releaseExpiredHolds();
        const now = serverNow();
        let soonest = null;
        let waitingSpot = false;

        windows.forEach((info, campaignId) => {
            if (!liveIds.has(campaignId) || claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return;
            if (info.hasPriority) {
                if (openIds.has(campaignId)) consider(campaignId);
                return;
            }
            const left = info.endsAt - now;
            if (left > armLeadMs()) {
                if (soonest == null || left < soonest) soonest = left;
                return;
            }
            if (openIds.has(campaignId)) consider(campaignId);
            else waitingSpot = true;
        });

        if (saveInflight.size || pursuing.size) return;

        if (Date.now() < vercelPauseUntil || siteBlocked()) {
            if (siteBlocked() && Date.now() >= vercelPauseUntil) noteVercelLimit();
            const left = Math.max(0, vercelPauseUntil - Date.now());
            showArmLabel(`PAUSED ${Math.ceil(left / 1000)}s`);
            return;
        }
        if (soonest != null && !sessionPause) {
            showArmLabel(`ARMED ${Math.max(0, Math.ceil(soonest / 1000))}s`);
            return;
        }
        if (waitingSpot && !sessionPause) {
            showArmLabel('WAITING FOR SPOT');
            return;
        }
        const holdLeft = nextHoldLeft(now);
        if (holdLeft != null && !sessionPause) {
            showArmLabel(`HOLD ${formatLeft(holdLeft)}`);
            return;
        }
        if (activeHeldSpots > 0 && !sessionPause) {
            showArmLabel(`HUNTING (${activeHeldSpots} HELD)`);
            return;
        }
        if (!sessionPause) showArmLabel('WATCHING');
    }

    function runWorkerPolls() {
        const now = Date.now();
        if (!capacityRunning && now - lastCapacityAt >= CONFIG.fastPollMs - 10) {
            lastCapacityAt = now;
            pollCapacity();
        }
        if (now - lastResSyncAt >= 2000) {
            lastResSyncAt = now;
            syncReservations();
        }
        if (now - lastLiveSyncAt >= CONFIG.liveSyncMs) {
            lastLiveSyncAt = now;
            syncLiveCampaigns();
        }
        if (now - lastSessionEvalAt >= 20000) {
            lastSessionEvalAt = now;
            evaluateSession();
        }
    }

    function startWorkerTicker() {
        const workerCode = `
            setInterval(() => postMessage('arm'), ${CONFIG.armTickMs});
            setInterval(() => postMessage('poll'), ${CONFIG.fastPollMs});
        `;
        const startFallback = () => {
            workerActive = false;
            setInterval(() => {
                armTick();
                runWorkerPolls();
            }, CONFIG.armTickMs);
        };

        try {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);
            URL.revokeObjectURL(url);
            workerActive = true;
            worker.onmessage = event => {
                if (event.data === 'poll') runWorkerPolls();
                else armTick();
            };
            worker.onerror = () => startFallback();
        } catch (e) {
            startFallback();
        }
    }

    function maintenance() {
        try {
            if (unavailable.size > 1000) unavailable.clear();
            if (notifiedActive.size > 1000) notifiedActive.clear();
            if (notifiedPriority.size > 1000) notifiedPriority.clear();
            if (apiWarned.size > 1000) apiWarned.clear();
            if (deadIds.size > 1000) deadIds.clear();
        } catch (e) {}
    }

    // ==========================================
    // 13. SAFE TESTS & MENU COMMANDS
    // ==========================================
    function formatLeft(ms) {
        if (ms == null) return 'no session cookie';
        const sign = ms < 0 ? '-' : '';
        const abs = Math.abs(ms);
        const min = Math.floor(abs / 60000);
        const sec = Math.floor((abs % 60000) / 1000);
        return `${sign}${min}m ${sec}s`;
    }

    function runSafeTests() {
        const session = readSession();
        const left = expiryLeft(session);
        const creds = savedLogin();
        let chime = 'played';
        try { playSuccessChime(); } catch (e) { chime = 'blocked'; }

        const lines = [
            'Safe test (v19.2.2 — zero saves fired).',
            '',
            `Web Worker: ${workerActive ? 'active (bg-immune)' : 'fallback timer'}`,
            `Capacity Poll Cadence: ${CONFIG.fastPollMs}ms`,
            `Action ID: ${liveAction}`,
            `Deployment ID: ${currentDeployment()}`,
            `Live Campaigns Tracked: ${liveIds.size}`,
            `Non-Live Cached: ${deadIds.size}`,
            `Baselined Open Ignored: ${alreadyOpen.size}`,
            `Server Clock Offset: ${clockCalibrated ? serverClockOffsetMs + 'ms' : 'uncalibrated'}`,
            `Measured Transit Lead: ${armLeadMs()}ms`,
            `Own Active Holds Tracked: ${claimedUntil.size}`,
            `Other Active Holds Detected: ${activeHeldSpots}`,
            `Session: ${formatLeft(left)}`,
            `Saved Login: ${creds.username ? '@' + creds.username : 'not set'}`,
            `Chime: ${chime}`
        ];

        setHud('SAFE TEST');
        fetchLiveCapacities().then(rows => {
            const openLive = (Array.isArray(rows) ? rows : []).filter(r => r && liveIds.has(String(r.campaign_id).toLowerCase()) && Number(r.spots_left) > 0);
            lines.push(`Open live spots from API: ${openLive.length}`);
            sendTelegramAlert('<b>TEST ALERT</b>\n\nSubsGigs v19.2.2 safe test connected.', status => {
                lines.push(status === 200 ? 'Telegram: sent.' : `Telegram: failed (${status}).`);
                alert(lines.join('\n'));
            });
        });
    }

    try {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('Run safe tests', () => runSafeTests());

            GM_registerMenuCommand('Save SubsGigs login', () => {
                const username = prompt('X username', gmGet('sg_user', ''));
                if (!username) return;
                const password = prompt('SubsGigs password (stored in Tampermonkey only)');
                if (!password) return;
                gmSet('sg_user', username.trim().replace(/^@/, ''));
                gmSet('sg_pass', password);
                gmSet('sg_login_fails', 0);
                gmSet('sg_auto', 1);
                alert('Saved. Auto login is on.');
            });

            GM_registerMenuCommand('Forget saved login', () => {
                gmSet('sg_user', '');
                gmSet('sg_pass', '');
                gmSet('sg_login_fails', 0);
                alert('Saved login removed.');
            });

            GM_registerMenuCommand('Pause or resume auto login', () => {
                const next = gmGet('sg_auto', 1) ? 0 : 1;
                gmSet('sg_auto', next);
                alert(next ? 'Auto login is on.' : 'Auto login is paused.');
            });

            GM_registerMenuCommand('Clear script memory', () => {
                claimed.clear();
                claimedUntil.clear();
                holdBridge.clear();
                deadIds.clear();
                verifyingIds.clear();
                alreadyOpen.clear();
                unavailable.clear();
                holdingFull.clear();
                sawEmpty.clear();
                fullSince.clear();
                recatchArmed.clear();
                optimisticTried.clear();
                notifiedActive.clear();
                notifiedPriority.clear();
                sentThisOpen.clear();
                needRateRetry.clear();
                rateRetried.clear();
                apiWarned.clear();
                postLedger.clear();
                baselineReady = false;
                if (!sessionPause) renderHUD('MEMORY CLEARED');
                syncLiveCampaigns();
                syncReservations();
                alert('Memory cleared.');
            });
        }
    } catch (e) {}

    window.addEventListener('click', () => {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) audioCtx = new AudioContextClass();
        }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }, { once: true });

    document.addEventListener('visibilitychange', () => {
        if (lastArmLabel) renderHUD(lastArmLabel);
    });

    function preconnect(href) {
        try {
            if (!document.head) return;
            const link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = href;
            link.crossOrigin = 'anonymous';
            document.head.appendChild(link);
        } catch (e) {}
    }

    async function boot() {
        loadClaimed();
        createHUD();
        preconnect(CONFIG.supabaseUrl);
        evaluateSession();
        harvest();
        await Promise.all([
            syncProfile(),
            syncLiveCampaigns(),
            syncReservations()
        ]);
        const now = Date.now();
        lastCapacityAt = now;
        lastResSyncAt = now;
        lastLiveSyncAt = now;
        lastSessionEvalAt = now;
        await pollCapacity();
        startWorkerTicker();

        setInterval(harvest, CONFIG.harvestMs);
        setInterval(maintenance, CONFIG.maintenanceInterval);
        setInterval(watchPage, 500);
    }

    hookPageFetch();
    evaluateSession();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();