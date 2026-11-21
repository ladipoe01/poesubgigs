import { config } from './config.js';
import { clock } from './clock.js';
import { log } from './log.js';
import { alertOnce, sendTelegram } from './telegram.js';
import { discoverBuild } from './discover.js';
import { startPersistentBrowser, submitCampaign } from './browser.js';
import {
    absorbCookies,
    accessToken,
    expiryLeft,
    ingestAuthCookie,
    isCheckpoint,
    loadState,
    loginWithPassword,
    persist,
    refreshSession,
    store,
    userId
} from './session.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const claimed = new Set();
const claimedUntil = new Map();
const holdBridge = new Map();
const liveIds = new Set();
const deadIds = new Map();
const verifyingIds = new Set();
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
let reservationsReady = false;
let liveIdsReady = false;
let userHasPriority = false;
let lastArmLabel = '';
let sessionPause = false;
let authBusy = false;
let verifyRunning = 0;
let vercelPauseUntil = 0;
let vercelBackoffMs = config.vercelWaitMs;
let vercelTold = false;
let rateTimer = 0;
let reservationSyncing = false;
let stopped = false;
let loopsStarted = false;
let minimalLogged = false;
const supabaseWarned = new Set();

function isCampaignId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}

function sleep(ms) {
    return new Promise(resolve => {
        const step = 200;
        let left = ms;
        const tick = () => {
            if (stopped || left <= 0) {
                resolve();
                return;
            }
            const wait = Math.min(step, left);
            left -= wait;
            setTimeout(tick, wait);
        };
        tick();
    });
}

function showArmLabel(label) {
    if (label === lastArmLabel) return;
    lastArmLabel = label;
    log(label);
}

function pauseSaves(mode) {
    sessionPause = true;
    showArmLabel(mode);
}

function publicHeaders() {
    return {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Accept: 'application/json'
    };
}

function userHeaders() {
    const token = accessToken();
    return {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${token || config.supabaseKey}`,
        Accept: 'application/json'
    };
}

async function supabaseGet(path, auth = true) {
    const started = performance.now();
    let response = await fetch(`${config.supabaseUrl}${path}`, {
        cache: 'no-store',
        headers: auth ? userHeaders() : publicHeaders(),
        signal: AbortSignal.timeout(8000)
    });
    clock.update(response, started);
    if (response.status === 401 && auth && await refreshSession()) {
        const retryStart = performance.now();
        response = await fetch(`${config.supabaseUrl}${path}`, {
            cache: 'no-store',
            headers: userHeaders(),
            signal: AbortSignal.timeout(8000)
        });
        clock.update(response, retryStart);
    }
    if (!response.ok) {
        const key = `${response.status} ${path.split('?')[0]}`;
        if (!supabaseWarned.has(key)) {
            supabaseWarned.add(key);
            log(`supabase ${response.status} on ${path.split('?')[0]}`);
        }
        return null;
    }
    const data = await response.json();
    return Array.isArray(data) ? data : null;
}

function canPostNow(campaignId) {
    const cutoff = Date.now() - 3600 * 1000;
    const times = (postLedger.get(campaignId) || []).filter(stamp => stamp > cutoff);
    postLedger.set(campaignId, times);
    return times.length < config.maxPostsPerHour;
}

function recordPostLedger(campaignId) {
    const now = Date.now();
    const cutoff = now - 3600 * 1000;
    const times = (postLedger.get(campaignId) || []).filter(stamp => stamp > cutoff);
    times.push(now);
    postLedger.set(campaignId, times);
}

function warnOnce(campaignId, message) {
    if (apiWarned.has(campaignId)) return;
    apiWarned.add(campaignId);
    sendTelegram(message);
}

function signalSave(campaignId, dry) {
    if (notifiedActive.has(campaignId)) return;
    notifiedActive.add(campaignId);
    const info = windows.get(campaignId);
    const lead = clock.armLead();
    if (dry) {
        sendTelegram(info
            ? `<b>DRY RUN</b>\n\n<code>${campaignId}</code>\nWould save a priority spot. Lead ${lead}ms.`
            : `<b>DRY RUN</b>\n\n<code>${campaignId}</code>\nWould save.`);
        return;
    }
    sendTelegram(info
        ? `<b>PRIORITY SPOT OPEN</b>\n\n<code>${campaignId}</code>\nSave fired (lead ${lead}ms).`
        : `<b>SPOT OPEN</b>\n\n<code>${campaignId}</code>\nSave fired.`);
}

function noteWindow(campaignId, endsAt, hasPriority, precise) {
    if (!campaignId || !Number.isFinite(endsAt)) return;
    const id = campaignId.toLowerCase();
    const prev = windows.get(id);
    if (prev && prev.precise && !precise) return;
    windows.set(id, { endsAt, hasPriority: !!hasPriority, precise: !!precise });
    timingKnown.add(id);
    alreadyOpen.delete(id);
    const left = endsAt - clock.now();
    if (!hasPriority && left > 0 && !notifiedPriority.has(id)) {
        notifiedPriority.add(id);
        const secs = Math.max(0, Math.ceil(left / 1000));
        sendTelegram(`<b>PRIORITY COUNTDOWN</b>\n\n<code>${id}</code>\nPublic save opens in ${secs}s.`);
    }
    if (hasPriority && openIds.has(id)) consider(id);
}

function publicWait(campaignId) {
    const info = windows.get(campaignId);
    if (!info || info.hasPriority) return false;
    return (info.endsAt - clock.now()) > clock.armLead();
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

function routerTree() {
    if (store.routerTree) return store.routerTree;
    return encodeURIComponent(JSON.stringify(listTree()));
}

function currentAction() {
    return store.actionId || config.defaultActionId;
}

function currentDeployment() {
    return store.deploymentId || config.defaultDeploymentId;
}

function savedText(response, text) {
    if (!response) return false;
    if (/"success"\s*:\s*"Spot saved/i.test(text || '')) return true;
    if (response.headers.get('x-action-redirect') || response.headers.get('x-nextjs-redirect') || response.headers.get('location')) {
        return true;
    }
    return /spot saved|saved for|reservation confirmed|spot reserved|held for \d+ minute/i.test(text || '');
}

function replyClip(text) {
    return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function noteVercelLimit() {
    if (Date.now() < vercelPauseUntil) return;
    const wait = vercelBackoffMs;
    vercelPauseUntil = Date.now() + wait;
    vercelBackoffMs = Math.min(vercelBackoffMs * 2, config.vercelWaitMaxMs);
    needRateRetry.clear();
    showArmLabel(`PAUSED ${Math.ceil(wait / 1000)}s`);
    if (!vercelTold) {
        vercelTold = true;
        sendTelegram(`<b>SAVES PAUSED</b>\n\nRate limit hit. Pausing for ${Math.ceil(wait / 1000)}s.`);
    }
}

function scheduleRateRetry(wait) {
    if (rateTimer) return;
    rateTimer = setTimeout(() => {
        rateTimer = 0;
        if (stopped) return;
        if (Date.now() < vercelPauseUntil) {
            scheduleRateRetry(Math.max(0, vercelPauseUntil - Date.now()));
            return;
        }
        vercelTold = false;
        if (sessionPause) return;
        const ids = [...needRateRetry];
        needRateRetry.clear();
        ids.forEach(id => {
            if (!openIds.has(id) || claimed.has(id) || unavailable.has(id) || holdingFull.has(id)) return;
            pursue(id, true);
        });
    }, wait + 40);
}

function spotsLeft(campaignId) {
    const url = `${config.supabaseUrl}/rest/v1/campaign_capacity?select=spots_left&campaign_id=eq.${campaignId}`;
    const started = performance.now();
    return fetch(url, {
        cache: 'no-store',
        headers: publicHeaders(),
        signal: AbortSignal.timeout(8000)
    }).then(async response => {
        clock.update(response, started);
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

function rememberClaimed(campaignId) {
    const id = campaignId.toLowerCase();
    const bridge = clock.now() + 20000;
    claimed.add(id);
    holdBridge.set(id, bridge);
    claimedUntil.set(id, bridge);
    windows.delete(id);
    syncReservations();
}

function finishSaved(campaignId) {
    rememberClaimed(campaignId);
    holdingFull.delete(campaignId);
    fullSince.delete(campaignId);
    recatchArmed.delete(campaignId);
    sentThisOpen.delete(campaignId);
    vercelBackoffMs = config.vercelWaitMs;
    showArmLabel('SPOT CLAIMED');
    const lead = clock.armLead();
    sendTelegram(`<b>SPOT CLAIMED</b>\n\n<b>Campaign ID:</b> <code>${campaignId}</code>\n<b>RTT:</b> ${clock.lastLatency}ms | <b>Lead:</b> ${lead}ms\n<b>Status:</b> Spot saved for 10 mins.`);
}

async function saveOnce(campaignId) {
    if (!isCampaignId(campaignId)) return 'full';
    if (sessionPause || publicWait(campaignId)) return 'wait';
    if (Date.now() < vercelPauseUntil) return 'wait';
    if (claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return 'full';
    if (saveInflight.has(campaignId)) return 'wait';
    if (!accessToken() && !cookieHeader()) {
        pauseSaves('SIGNED OUT');
        return 'login';
    }
    if (!canPostNow(campaignId)) {
        warnOnce(campaignId, `<b>SAFETY CAP</b>\n\n<code>${campaignId}</code>\nReached ${config.maxPostsPerHour} POSTs/hr limit.`);
        return 'full';
    }
    if (config.dryRun) {
        signalSave(campaignId, true);
        log(`dry run would save ${campaignId}`);
        return 'dry';
    }

    const beforePromise = spotsLeft(campaignId);
    saveInflight.add(campaignId);
    recordPostLedger(campaignId);
    const started = performance.now();
    signalSave(campaignId, false);
    showArmLabel('SAVE SENT');

    try {
        const posted = await submitCampaign(campaignId, currentAction(), routerTree(), currentDeployment());
        const rtt = performance.now() - started;
        clock.update(posted, started);
        clock.recordFlight(rtt);
        absorbCookies(posted);
        ingestAuthCookie();
        const deployment = posted.headers.get('x-deployment-id');
        if (deployment && deployment !== store.deploymentId) {
            store.deploymentId = deployment;
            persist();
        }

        const text = await posted.text();
        const lower = text.toLowerCase();

        if (posted.status === 429 || posted.status === 502 || posted.status === 503 || isCheckpoint(text) || /security checkpoint|too many requests/i.test(lower)) {
            noteVercelLimit();
            return 'rate';
        }
        if (String(posted.url || '').includes('/login') || lower.includes('sign in to subsgigs')) {
            goLogin();
            return 'login';
        }
        if (posted.headers.get('x-nextjs-action-not-found') === '1' || /server action .* was not found|e715/i.test(text)) {
            store.actionId = '';
            discoverBuild().then(() => persist());
            return 'stale';
        }
        if (/priority access|open to everyone in|priority window/i.test(lower)) {
            const secMatch = text.match(/open to everyone in (\d+) seconds/i);
            if (secMatch) noteWindow(campaignId, clock.now() + Number(secMatch[1]) * 1000, false, false);
            showArmLabel('PRIORITY GATE');
            return 'wait';
        }
        if (/spot is full|no spots left|campaign full|no remaining spots|entry limit/.test(lower)) {
            markFull(campaignId);
            showArmLabel('SPOT FULL');
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
                showArmLabel('PRIORITY GATE');
                return 'wait';
            }
            if (/spot is full|no spots left|campaign full|no remaining|entry limit/i.test(alertText)) {
                markFull(campaignId);
                showArmLabel('SPOT FULL');
                return 'full';
            }
            warnOnce(campaignId, `<b>SAVE NOT ACCEPTED</b>\n\n<code>${campaignId}</code>\n${alertText}`);
            unavailable.add(campaignId);
            return 'full';
        }

        warnOnce(campaignId, `<b>SAVE UNCONFIRMED</b>\n\n<code>${campaignId}</code>\nHTTP ${posted.status}. Spots before: ${before == null ? '?' : before}.\n<code>${replyClip(text) || 'empty reply'}</code>`);
        unavailable.add(campaignId);
        showArmLabel('SAVE UNCONFIRMED');
        return 'full';
    } catch (error) {
        log(`save ${campaignId} failed: ${error.message}`);
        return 'retry';
    } finally {
        saveInflight.delete(campaignId);
    }
}

async function pursue(campaignId, extra) {
    if (claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return;
    if (sessionPause || publicWait(campaignId)) return;
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
        if (result === 'dry') return;
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
    if (!campaignId || !baselineReady || !reservationsReady || !liveIdsReady) return;
    if (alreadyOpen.has(campaignId) || claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return;
    if (!liveIds.has(campaignId)) return;
    if (Date.now() < vercelPauseUntil) return;

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

    if (publicWait(campaignId) || sessionPause) return;
    if (!openIds.has(campaignId)) return;
    pursue(campaignId, false);
}

async function learnTiming(campaignId) {
    if (!campaignId || timingKnown.has(campaignId) || timingLoading.has(campaignId)) return;
    timingLoading.set(campaignId, true);
    try {
        const rows = await supabaseGet(`/rest/v1/campaigns?select=status,live_at,priority_access_window_seconds&id=eq.${campaignId}&limit=1`);
        if (!rows) return;
        timingKnown.add(campaignId);
        if (rows[0]) {
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
                if (endsAt > clock.now()) noteWindow(campaignId, endsAt, !!userHasPriority, true);
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
    if (deadCheckedAt && Date.now() - deadCheckedAt < config.liveSyncMs) return;

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
            if (endsAt > clock.now()) noteWindow(id, endsAt, !!userHasPriority, true);
        }
        if (hadOpenSpots) {
            openIds.add(id);
            absentSince.delete(id);
        }
        if (openIds.has(id) && !sessionPause && Date.now() >= vercelPauseUntil) consider(id);
    } finally {
        verifyingIds.delete(id);
    }
}

function markFull(campaignId) {
    holdingFull.add(campaignId);
    fullSince.set(campaignId, Date.now());
    recatchArmed.delete(campaignId);
    sawEmpty.delete(campaignId);
    alreadyOpen.delete(campaignId);
    learnTiming(campaignId);
    warnOnce(campaignId, `<b>SPOT FULL</b>\n\n<code>${campaignId}</code>\nWatching for released or expired spots.`);
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
        if (since == null || now - since < config.fullRetryMs) return;
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
        if (since && now - since >= config.absentMs) {
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
    if (config.baseline) {
        openNow.forEach(id => {
            const info = windows.get(id);
            if (info && !info.hasPriority) return;
            alreadyOpen.add(id);
        });
    }
    baselineReady = true;
    log(`baseline ready, ignoring ${alreadyOpen.size} already-open campaign${alreadyOpen.size === 1 ? '' : 's'}`);
}

function fetchLiveCapacities() {
    const query = useMinimalCapacitySelect
        ? 'select=campaign_id,spots_left&spots_left=gt.0'
        : 'select=campaign_id,spots_left,active_reservations';
    const started = performance.now();
    return fetch(`${config.supabaseUrl}/rest/v1/campaign_capacity?${query}`, {
        cache: 'no-store',
        headers: publicHeaders(),
        signal: AbortSignal.timeout(8000)
    }).then(async response => {
        clock.update(response, started);
        if (!response.ok) {
            if (response.status === 400 && !useMinimalCapacitySelect) {
                useMinimalCapacitySelect = true;
                if (!minimalLogged) {
                    minimalLogged = true;
                    log('capacity view has no active_reservations column; hold counts are off');
                }
            }
            return null;
        }
        const rows = await response.json();
        return Array.isArray(rows) ? rows : null;
    }).catch(() => null);
}

async function pollCapacity() {
    if (capacityRunning || !liveIdsReady) return;
    capacityRunning = true;
    try {
        const rows = await fetchLiveCapacities();
        if (!rows) return;

        const now = Date.now();
        const nextOpen = new Set();
        let heldOtherCount = 0;

        rows.forEach(row => {
            if (!row?.campaign_id || !isCampaignId(String(row.campaign_id))) return;
            const id = String(row.campaign_id).toLowerCase();
            const deadCheckedAt = deadIds.get(id);
            if (deadCheckedAt) {
                if (now - deadCheckedAt < config.liveSyncMs) return;
                deadIds.delete(id);
            }
            const spots = Number(row.spots_left) || 0;
            const held = Number(row.active_reservations) || 0;
            if (!liveIds.has(id)) {
                if ((spots > 0 || held > 0) && verifyRunning < 3) {
                    verifyRunning += 1;
                    verifyLiveCampaign(id, spots > 0).finally(() => { verifyRunning -= 1; });
                }
                return;
            }
            if (spots > 0) nextOpen.add(id);
            else if (held > 0 && !claimed.has(id)) heldOtherCount += held;
        });

        activeHeldSpots = heldOtherCount;
        applyOpenSet(nextOpen);
        if (!baselineReady) takeBaseline(nextOpen);
        settle();
        if (sessionPause || Date.now() < vercelPauseUntil) return;

        openIds.forEach(id => consider(id));
        recatchArmed.forEach(id => {
            if (!liveIds.has(id) || claimed.has(id) || holdingFull.has(id) || pursuing.has(id)) return;
            sentThisOpen.delete(id);
            pursue(id, false);
        });
    } finally {
        capacityRunning = false;
    }
}

async function syncLiveCampaigns() {
    const rows = await supabaseGet('/rest/v1/campaigns?select=id&status=eq.live');
    if (!rows) return false;
    const nextLive = new Set();
    rows.forEach(row => {
        if (row && isCampaignId(row.id)) {
            const id = row.id.toLowerCase();
            nextLive.add(id);
            deadIds.delete(id);
            unavailable.delete(id);
        }
    });
    liveIds.clear();
    nextLive.forEach(id => liveIds.add(id));
    liveIdsReady = true;
    return true;
}

async function syncProfile() {
    const me = userId();
    if (!me) return;
    const rows = await supabaseGet(`/rest/v1/profiles?select=has_priority_access&id=eq.${me}&limit=1`);
    if (rows && rows[0]) userHasPriority = !!rows[0].has_priority_access;
}

async function syncReservations() {
    if (reservationSyncing) return;
    reservationSyncing = true;
    try {
        const me = userId();
        const rows = await supabaseGet('/rest/v1/campaign_spot_reservations?select=campaign_id,profile_id,expires_at,released_at&released_at=is.null');
        if (!rows) return;
        const now = clock.now();
        const next = new Map();
        rows.forEach(row => {
            if (!row || !isCampaignId(row.campaign_id) || row.released_at) return;
            if (!me || row.profile_id !== me) return;
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
        reservationsReady = true;
    } finally {
        reservationSyncing = false;
    }
}

function releaseExpiredHolds() {
    const now = clock.now();
    const due = [];
    claimedUntil.forEach((until, id) => {
        if (until + (config.recatchDelayMs || 0) <= now) due.push(id);
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

function hasImminentWindow() {
    const now = clock.now();
    for (const info of windows.values()) {
        if (!info.hasPriority && info.endsAt > now && (info.endsAt - now) <= config.deferRenewWindowMs) return true;
    }
    return false;
}

async function goLogin(nested = false) {
    if (!config.username || !config.password) {
        pauseSaves('SET LOGIN');
        await alertOnce('need-login', '<b>SESSION DOWN</b>\n\nSet SG_SESSION_JSON, or set SG_USERNAME and SG_PASSWORD.');
        return;
    }
    if (store.loginFails >= 3) {
        pauseSaves('LOGIN FAILED');
        return;
    }
    if (authBusy && !nested) return;
    if (!nested) authBusy = true;
    showArmLabel('AUTO LOGIN');
    try {
        const result = await loginWithPassword({ deploymentId: currentDeployment() });
        if (result.ok) {
            store.loginFails = 0;
            store.rotateFails = 0;
            sessionPause = false;
            showArmLabel('LOGIN RENEWED');
            await sendTelegram('<b>LOGIN RENEWED</b>');
            return;
        }
        if (result.reason === 'challenge') {
            noteVercelLimit();
            return;
        }
        store.loginFails += 1;
        persist();
        pauseSaves(store.loginFails >= 3 ? 'LOGIN FAILED' : 'LOGIN REJECTED');
        if (store.loginFails >= 3) {
            await sendTelegram('<b>LOGIN FAILED</b>\n\nCheck the username and password, then redeploy.');
        }
    } finally {
        if (!nested) authBusy = false;
    }
}

async function scheduleRotate(recover) {
    if (Date.now() < store.rotateUntil || authBusy) return;
    store.rotateUntil = Date.now() + 8000;
    authBusy = true;
    showArmLabel(recover ? 'RENEWING AFTER SNAG' : 'RENEWING LOGIN');
    try {
        const ok = await refreshSession();
        if (ok) {
            store.rotateFails = 0;
            store.rotateUntil = Date.now() + 20 * 60 * 1000;
            sessionPause = false;
            showArmLabel('LOGIN RENEWED');
            return;
        }
        store.rotateFails += 1;
        store.rotateUntil = 0;
        persist();
        const left = expiryLeft();
        if (recover || store.rotateFails >= 2 || left == null || left <= config.dangerBelowMs) await goLogin(true);
    } finally {
        authBusy = false;
    }
}

async function evaluateSession() {
    const session = store.session;
    const left = expiryLeft(session);
    if (session && left > config.renewBelowMs) {
        sessionPause = false;
        store.rotateFails = 0;
        store.loginFails = 0;
        return;
    }
    if (session && left > config.dangerBelowMs) {
        sessionPause = false;
        if (!hasImminentWindow()) await scheduleRotate(false);
        return;
    }
    if (session?.refresh_token && store.rotateFails < 2) {
        pauseSaves(session ? 'TOKEN RISK' : 'SIGNED OUT');
        await scheduleRotate(true);
        return;
    }
    pauseSaves(session ? 'TOKEN RISK' : 'SIGNED OUT');
    if (config.username || session) await goLogin();
}

function formatLeft(ms) {
    if (ms == null) return 'no session';
    const sign = ms < 0 ? '-' : '';
    const abs = Math.abs(ms);
    const min = Math.floor(abs / 60000);
    const sec = Math.floor((abs % 60000) / 1000);
    return `${sign}${min}m ${sec}s`;
}

function armTick() {
    settle();
    releaseExpiredHolds();
    const now = clock.now();
    let soonest = null;
    let waitingSpot = false;
    let nextDelay = 250;

    windows.forEach((info, campaignId) => {
        const left = info.endsAt - now;
        if (left < -120000) {
            windows.delete(campaignId);
            return;
        }
        if (!liveIds.has(campaignId) || claimed.has(campaignId) || unavailable.has(campaignId) || holdingFull.has(campaignId)) return;
        if (info.hasPriority) {
            if (openIds.has(campaignId)) consider(campaignId);
            return;
        }
        if (left > clock.armLead()) {
            if (soonest == null || left < soonest) soonest = left;
            const fireIn = left - clock.armLead();
            if (fireIn < 250) nextDelay = Math.min(nextDelay, Math.max(5, fireIn));
            return;
        }
        if (openIds.has(campaignId)) consider(campaignId);
        else waitingSpot = true;
    });

    if (saveInflight.size || pursuing.size) return 20;
    if (Date.now() < vercelPauseUntil) {
        const left = Math.max(0, vercelPauseUntil - Date.now());
        showArmLabel(`PAUSED ${Math.ceil(left / 1000)}s`);
        return Math.min(1000, Math.max(200, left));
    }
    if (soonest != null && !sessionPause) {
        showArmLabel(`ARMED ${Math.max(0, Math.ceil(soonest / 1000))}s`);
        return nextDelay;
    }
    if (waitingSpot && !sessionPause) {
        showArmLabel('WAITING FOR SPOT');
        return nextDelay;
    }
    let holdLeft = null;
    claimedUntil.forEach(value => {
        if (holdLeft == null || value < holdLeft) holdLeft = value;
    });
    if (holdLeft != null) holdLeft = Math.max(0, holdLeft - now);
    if (holdLeft != null && !sessionPause) {
        showArmLabel(`HOLD ${formatLeft(holdLeft)}`);
        return nextDelay;
    }
    if (activeHeldSpots > 0 && !sessionPause) {
        showArmLabel(`HUNTING (${activeHeldSpots} HELD)`);
        return nextDelay;
    }
    if (!sessionPause) showArmLabel('WATCHING');
    return nextDelay;
}

async function pollLoop() {
    while (!stopped) {
        const started = Date.now();
        try { await pollCapacity(); }
        catch (error) { log(`poll error: ${error.message}`); }
        await sleep(Math.max(20, config.fastPollMs - (Date.now() - started)));
    }
}

async function maintenanceLoop() {
    let lastRes = Date.now();
    let lastLive = Date.now();
    let lastSession = Date.now();
    let lastStatus = 0;
    let lastDiscover = Date.now();
    while (!stopped) {
        const now = Date.now();
        try {
            if (now - lastRes >= 2000) {
                lastRes = now;
                await syncReservations();
            }
            if (now - lastLive >= config.liveSyncMs) {
                lastLive = now;
                await syncLiveCampaigns();
            }
            if (now - lastSession >= 20000) {
                lastSession = now;
                await evaluateSession();
            }
            if (now - lastDiscover >= 10 * 60 * 1000) {
                lastDiscover = now;
                const found = await discoverBuild();
                if (found.actionId || found.deploymentId) persist();
                if (found.blocked) log('site challenge during discovery; saves keep their own pause');
            }
            if (now - lastStatus >= 60000) {
                lastStatus = now;
                const snap = snapshot();
                log(`status ${snap.label} live=${snap.live} open=${snap.open} holds=${snap.holds} otherHeld=${snap.otherHeld} rtt=${snap.rtt}ms session=${snap.session}`);
            }
            if (unavailable.size > 1000) unavailable.clear();
            if (notifiedActive.size > 1000) notifiedActive.clear();
            if (notifiedPriority.size > 1000) notifiedPriority.clear();
            if (apiWarned.size > 1000) apiWarned.clear();
            if (deadIds.size > 1000) deadIds.clear();
        } catch (error) {
            log(`maintenance error: ${error.message}`);
        }
        await sleep(250);
    }
}

async function armLoop() {
    while (!stopped) {
        let delay = 250;
        try { delay = armTick() || 250; }
        catch (error) { log(`arm error: ${error.message}`); }
        await sleep(delay);
    }
}

function snapshot() {
    return {
        version: '19.2.2-cloud',
        label: lastArmLabel || 'STARTING',
        live: liveIds.size,
        open: openIds.size,
        holds: claimedUntil.size,
        otherHeld: activeHeldSpots,
        rtt: clock.lastLatency,
        leadMs: clock.armLead(),
        clockOffsetMs: clock.calibrated ? Math.round(clock.offsetMs) : null,
        session: formatLeft(expiryLeft()),
        paused: sessionPause,
        dryRun: config.dryRun,
        vercelPauseMs: Math.max(0, vercelPauseUntil - Date.now()),
        actionKnown: Boolean(store.actionId || config.defaultActionId),
        priority: userHasPriority
    };
}

async function boot() {
    loadState();
    await startPersistentBrowser();
    log(`SubsGigs cloud v19.2.2 poll=${config.fastPollMs}ms dryRun=${config.dryRun} baseline=${config.baseline}`);
    if (!store.session && !config.username) {
        pauseSaves('SET LOGIN');
        await alertOnce('need-login', '<b>SESSION DOWN</b>\n\nSet SG_SESSION_JSON, or set SG_USERNAME and SG_PASSWORD.');
    }
    const found = await discoverBuild();
    if (!store.actionId) store.actionId = config.defaultActionId;
    if (!store.deploymentId) store.deploymentId = config.defaultDeploymentId;
    if (found.blocked) log('site challenge on boot; session JSON still works for Supabase, saves pause only after a blocked POST');
    persist();
    await evaluateSession();
    await Promise.all([syncProfile(), syncLiveCampaigns(), syncReservations()]);
    await pollCapacity();
}

function start() {
    if (loopsStarted || stopped) return;
    loopsStarted = true;
    pollLoop();
    maintenanceLoop();
    armLoop();
}

function stop() {
    stopped = true;
    if (rateTimer) {
        clearTimeout(rateTimer);
        rateTimer = 0;
    }
}

function busy() {
    return saveInflight.size > 0 || pursuing.size > 0 || authBusy;
}

export const engine = { boot, start, stop, busy, snapshot };
