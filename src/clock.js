import { config } from './config.js';

export const clock = {
    offsetMs: 0,
    calibrated: false,
    lastLatencyMs: 0,
    lastLatency: '--',
    samples: [],

    now() {
        return Date.now() + this.offsetMs;
    },

    update(response, reqStartPerf) {
        try {
            const dateStr = response?.headers?.get('date');
            if (!dateStr) return;
            const serverHeaderMs = Date.parse(dateStr);
            if (!Number.isFinite(serverHeaderMs)) return;
            const rtt = Math.max(0, performance.now() - reqStartPerf);
            const estimatedServerNow = serverHeaderMs + 500 + (rtt / 2);
            const sampleOffset = estimatedServerNow - Date.now();
            if (!this.calibrated) {
                this.offsetMs = sampleOffset;
                this.calibrated = true;
            } else {
                this.offsetMs = Math.round(this.offsetMs * 0.7 + sampleOffset * 0.3);
            }
        } catch {
            // A missing or odd Date header leaves the previous offset in place.
        }
    },

    recordFlight(rttMs) {
        if (!Number.isFinite(rttMs) || rttMs <= 0) return;
        this.lastLatencyMs = rttMs;
        this.lastLatency = rttMs.toFixed(1);
        const oneWay = Math.round(rttMs * 0.48);
        this.samples.push(oneWay);
        if (this.samples.length > 12) this.samples.shift();
    },

    armLead() {
        if (!this.calibrated) return config.armLeadMinMs;
        let estOneWay = this.lastLatencyMs ? Math.round(this.lastLatencyMs * 0.48) : config.armLeadMinMs;
        if (this.samples.length >= 2) {
            const sorted = [...this.samples].sort((a, b) => a - b);
            estOneWay = sorted[Math.floor(sorted.length * 0.35)];
        }
        return Math.max(config.armLeadMinMs, Math.min(config.armLeadMaxMs, estOneWay));
    }
};
