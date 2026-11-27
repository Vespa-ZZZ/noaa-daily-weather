import { setTimeout as sleepDefault } from 'node:timers/promises';
import { pushDataWithinLimit } from './charging.js';
import { dataUrl, dateWindows, MAX_STATIONS, normalizeInput, parseDaily, parseSearch, searchUrl } from './noaa.js';

const INTERVAL_MS = 2_200;
const MAX_RETRIES = 3;
const MAX_TIMER_MS = 2_147_483_647;

function retryAfterMs(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 0;
}

function createJsonFetcher(fetchImpl, sleep) {
    let pause = 0;
    return async (url, service) => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
            if (pause > MAX_TIMER_MS) throw new Error(`NOAA ${service} requested a retry delay too long for this run.`);
            if (pause > 0) await sleep(pause);
            pause = INTERVAL_MS;
            let response;
            let body;
            try {
                response = await fetchImpl(url, {
                    headers: { Accept: 'application/json' },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(60_000),
                });
                if (response.ok) body = await response.text();
            } catch {
                if (attempt === MAX_RETRIES) throw new Error(`NOAA ${service} failed after retries (network or timeout).`);
                pause = INTERVAL_MS * 2 ** attempt;
                continue;
            }
            if (response.ok) {
                try {
                    return JSON.parse(body);
                } catch {
                    throw new Error(`NOAA ${service} returned invalid JSON.`);
                }
            }
            if (response.body) await response.body.cancel().catch(() => {});
            const retriable = response.status === 429 || (response.status >= 500 && response.status <= 599);
            if (!retriable || attempt === MAX_RETRIES) {
                throw new Error(`NOAA ${service} failed (HTTP ${response.status}).`);
            }
            pause = Math.max(INTERVAL_MS * 2 ** attempt, retryAfterMs(response.headers.get('retry-after')));
        }
    };
}

export async function runActor(input, {
    actor, fetchImpl = globalThis.fetch, sleep = sleepDefault, warn = () => {},
}) {
    const query = normalizeInput(input);
    const getJson = createJsonFetcher(fetchImpl, sleep);
    if (query.search) {
        const metadata = await getJson(searchUrl(query), 'station search');
        const { stations, truncated } = parseSearch(metadata);
        query.stations = stations;
        if (truncated) warn(`Station search is limited to ${MAX_STATIONS} IDs. Narrow the bounding box or use explicit station IDs.`);
    }
    if (query.stations.length === 0) {
        warn('No U.S. GHCN-Daily station matches the requested location and period.');
        return 0;
    }

    let total = 0;
    for (const window of dateWindows(query.startDate, query.endDate)) {
        const payload = await getJson(dataUrl(query, window), 'daily observations');
        const rows = parseDaily(payload, query, window);
        if (rows.length === 0) continue;
        const result = await pushDataWithinLimit(actor, rows);
        if (result?.eventChargeLimitReached) {
            total += result.chargedCount;
            warn('Pay-per-event charge limit reached. Stopping dataset output.');
            await actor.setValue?.('RUN_SUMMARY', { pushed: total, stopReason: 'spendingLimit' });
            return total;
        }
        total += rows.length;
    }
    if (total === 0) warn('NOAA returned no observations for the requested stations, dates, and data types.');
    return total;
}
