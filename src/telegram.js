import { config } from './config.js';
import { log } from './log.js';

const onceKeys = new Set();

export async function sendTelegram(message) {
    if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId) return 0;
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.telegram.chatId,
                text: String(message).slice(0, 3500),
                parse_mode: 'HTML'
            }),
            signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) log(`telegram status ${response.status}`);
        return response.status;
    } catch (error) {
        log(`telegram failed: ${error.message}`);
        return 0;
    }
}

export async function sendTelegramPhoto(buffer, caption = 'SubsGigs browser status') {
    if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId || !buffer) return 0;
    const form = new FormData();
    form.append('chat_id', config.telegram.chatId);
    form.append('caption', String(caption).slice(0, 900));
    form.append('photo', new Blob([buffer], { type: 'image/png' }), 'subsgigs-browser.png');
    try {
        const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendPhoto`, {
            method: 'POST', body: form, signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) log(`telegram photo status ${response.status}`);
        return response.status;
    } catch (error) {
        log(`telegram photo failed: ${error.message}`);
        return 0;
    }
}

export async function alertOnce(key, message) {
    if (onceKeys.has(key)) return 0;
    onceKeys.add(key);
    return sendTelegram(message);
}
