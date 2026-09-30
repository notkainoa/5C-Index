// 5C-Index proxy — upstream client for banana.hyperschedule.io.
//
// WinterCG only (fetch / Headers / AbortController / setTimeout). No node: imports.
//
// Politeness contract (see plan.md §8): UA with contact, If-None-Match,
// 3-try backoff honoring Retry-After, 15 s abort, circuit-breaker that
// flips to 5-min stale-only mode after 3 consecutive 5xx responses.

export const BANANA_BASE = "https://banana.hyperschedule.io";
export const USER_AGENT = "5C-Index/proxy (+contact)";
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_ATTEMPTS = 3;
export const STALE_ONLY_MS = 5 * 60 * 1000;

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;

export interface FetchBananaOptions {
	/** Value for If-None-Match (stored snapshot ETag). */
	etag?: string | null;
	/** Injectable fetch (tests / prewarm). Defaults to global fetch. */
	fetchFn?: typeof fetch;
	/** Abort timeout per attempt. Defaults to FETCH_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Injectable sleep (tests inject a no-op for determinism). */
	sleep?: (ms: number) => Promise<void>;
}

export interface BananaResult {
	status: number;
	/** Null for 304 / 404. */
	body: string | null;
	/** Upstream ETag (or the request etag echoed back on 304). */
	etag: string | null;
	notModified: boolean;
}

// --- Circuit breaker (per-isolate in-memory; see README open questions) ---
let consecutive5xx = 0;
let staleOnlyUntil = 0;

/** True while the breaker holds the isolate in stale-only mode. */
export function isStaleOnly(now: number = Date.now()): boolean {
	return now < staleOnlyUntil;
}

/** Test escape hatch (also used by prewarm smoke tests). */
export function resetCircuit(): void {
	consecutive5xx = 0;
	staleOnlyUntil = 0;
}

export function circuitState(): {
	consecutive5xx: number;
	staleOnlyUntil: number;
} {
	return { consecutive5xx, staleOnlyUntil };
}

function recordSuccess(): void {
	consecutive5xx = 0;
}

function record5xx(now: number): void {
	consecutive5xx += 1;
	if (consecutive5xx >= 3) {
		staleOnlyUntil = now + STALE_ONLY_MS;
	}
}

function parseRetryAfterMs(headers: Headers): number | null {
	const raw = headers.get("retry-after");
	if (!raw) return null;
	const secs = Number(raw.trim());
	if (Number.isFinite(secs) && secs >= 0) {
		return Math.min(secs * 1000, RETRY_CAP_MS);
	}
	const dateMs = Date.parse(raw);
	if (!Number.isNaN(dateMs)) {
		return Math.max(0, Math.min(dateMs - Date.now(), RETRY_CAP_MS));
	}
	return null;
}

function backoffMs(attempt: number): number {
	const exp = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
	return exp + Math.floor(Math.random() * 100); // jitter
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET path from banana with UA, conditional headers, retries and breaker.
 * Retries on 429 / 5xx / network errors only; 4xx (except 429) return as-is.
 * Throws only when every attempt fails at the network level.
 */
export async function fetchBanana(
	path: string,
	opts: FetchBananaOptions = {},
): Promise<BananaResult> {
	const fetchFn = opts.fetchFn ?? fetch;
	const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
	const sleep = opts.sleep ?? defaultSleep;
	const url = path.startsWith("http") ? path : `${BANANA_BASE}${path}`;

	let lastError: unknown = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const headers = new Headers({
				"user-agent": USER_AGENT,
				accept: "application/json",
			});
			if (opts.etag) headers.set("if-none-match", opts.etag);

			const res = await fetchFn(url, { headers, signal: ctrl.signal });
			clearTimeout(timer);

			if (res.status === 304) {
				recordSuccess();
				return {
					status: 304,
					body: null,
					etag: opts.etag ?? null,
					notModified: true,
				};
			}
			if (res.status === 404) {
				recordSuccess();
				return { status: 404, body: null, etag: null, notModified: false };
			}
			if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
				if (res.status >= 500) record5xx(Date.now());
				if (attempt < MAX_ATTEMPTS) {
					const wait = parseRetryAfterMs(res.headers) ?? backoffMs(attempt);
					try {
						await res.arrayBuffer();
					} catch {
						// Best-effort drain so the socket can be reused.
					}
					await sleep(wait);
					continue;
				}
				const body = await res.text().catch(() => "");
				return {
					status: res.status,
					body,
					etag: res.headers.get("etag"),
					notModified: false,
				};
			}

			recordSuccess();
			const body = await res.text();
			return {
				status: res.status,
				body,
				etag: res.headers.get("etag"),
				notModified: false,
			};
		} catch (err) {
			clearTimeout(timer);
			lastError = err;
			if (attempt < MAX_ATTEMPTS) {
				await sleep(backoffMs(attempt));
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`fetchBanana failed: ${String(lastError)}`);
}
