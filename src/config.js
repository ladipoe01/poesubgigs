import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Local runs read .env. Railway already injects variables, and those win.
try {
    const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        if (process.env[key]) continue;
        process.env[key] = trimmed.slice(eq + 1);
    }
} catch {
    // No local .env is normal on Railway.
}

function text(name, fallback = '') {
    const value = process.env[name];
    if (value == null || value.trim() === '') return fallback;
    return value.trim();
}

function num(name, fallback) {
    const value = text(name, '');
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(name, fallback) {
    const value = text(name, '');
    if (!value) return fallback;
    return /^(1|true|yes|on)$/i.test(value);
}

const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

export const config = {
    siteOrigin: text('SITE_ORIGIN', 'https://subsgigs-alpha.vercel.app').replace(/\/+$/, ''),
    supabaseUrl: text('SUPABASE_URL', 'https://kemvnhqbfaztwyhcerqh.supabase.co').replace(/\/+$/, ''),
    supabaseKey: text('SUPABASE_ANON_KEY', 'sb_publishable_p1bpyo6pXEiVtXTVso4W_A_XYfLmOqv'),
    username: text('SG_USERNAME', '').replace(/^@/, ''),
    password: text('SG_PASSWORD', ''),
    telegram: {
        enabled: flag('TELEGRAM_ENABLED', true),
        botToken: text('TELEGRAM_BOT_TOKEN', ''),
        chatId: text('TELEGRAM_CHAT_ID', '')
    },
    actionId: text('ACTION_ID', ''),
    deploymentId: text('DEPLOYMENT_ID', ''),
    defaultActionId: '60609598ef4dce85b16c4600c68a34b1019243ba7d',
    defaultDeploymentId: 'dpl_8qiPBTT3XeZX3yPHRR2bp53oQwEs',
    releaseActionId: '60d25657a57fc749794da54b3529b1bd845cfb1a49',
    dryRun: flag('DRY_RUN', false),
    monitorOnly: true,
    baseline: flag('BASELINE', true),
    fastPollMs: Math.max(50, num('FAST_POLL_MS', 150)),
    liveSyncMs: num('LIVE_SYNC_MS', 15000),
    fullRetryMs: num('FULL_RETRY_MS', 1500),
    recatchDelayMs: num('RECATCH_DELAY_MS', 0),
    armLeadMinMs: num('ARM_LEAD_MIN_MS', 40),
    armLeadMaxMs: num('ARM_LEAD_MAX_MS', 1500),
    absentMs: num('ABSENT_MS', 1200),
    maxPostsPerHour: num('MAX_POSTS_PER_HOUR', 8),
    renewBelowMs: num('RENEW_BELOW_MS', 8 * 60 * 1000),
    dangerBelowMs: num('DANGER_BELOW_MS', 130 * 1000),
    deferRenewWindowMs: num('DEFER_RENEW_WINDOW_MS', 60 * 1000),
    vercelWaitMs: num('VERCEL_WAIT_MS', 60 * 1000),
    vercelWaitMaxMs: num('VERCEL_WAIT_MAX_MS', 5 * 60 * 1000),
    statePath: text('STATE_PATH', onRailway ? '/data/session.json' : path.join(root, 'data', 'session.json')),
    browserProfilePath: text('BROWSER_PROFILE_PATH', onRailway ? '/data/profile' : path.join(root, 'data', 'profile')),
    port: num('PORT', 8080),
    statusToken: text('STATUS_TOKEN', ''),
    userAgent: text('USER_AGENT', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
};
