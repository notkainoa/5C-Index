import {
	rawHistorySchema,
	rawSectionsSchema,
	rawTermSchema,
} from "./schema.js";
import type { RawHistoryEntry, RawSection, RawTerm } from "./schema.js";

/**
 * HyperSchedule v4 HTTP client.
 * - Public, unauthenticated endpoints (verified live 2026-09-25).
 * - fetchFn injectable (default globalThis.fetch) so core stays portable.
 * - Always sends a polite contact User-Agent; retries 429/5xx with backoff.
 */

export const DEFAULT_API_BASE = "https://banana.hyperschedule.io/v4";
export const USER_AGENT = "5C-Index/0.1 (+research/edu; cache 60s)";

/**
 * Upstream base URL. `FIVE_C_API_BASE` overrides it so adapters can be tested
 * offline against a fixture server (and so a mirror can be pointed at without
 * a rebuild). Resolved per call: tests set the env var after importing core.
 */
export function apiBase(): string {
	const override = process.env.FIVE_C_API_BASE?.trim();
	return override ? override.replace(/\/+$/, "") : DEFAULT_API_BASE;
}

/** @deprecated Use apiBase(); kept for callers that want the default only. */
export const BANANA_BASE = DEFAULT_API_BASE;

export interface FetchResult<T> {
	data: T;
	etag: string | null;
	notModified: boolean;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export interface FetchOptions {
	etag?: string | null;
	timeoutMs?: number;
	retries?: number;
}

export async function fetchJson<T>(
	url: string,
	validate: (unknown: unknown) => T,
	opts: FetchOptions = {},
	fetchFn: typeof fetch = globalThis.fetch,
): Promise<FetchResult<T>> {
	const { etag, timeoutMs = 15000, retries = 3 } = opts;
	let lastErr: unknown = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetchFn(url, {
				signal: ctrl.signal,
				headers: {
					Accept: "application/json",
					"User-Agent": USER_AGENT,
					...(etag ? { "If-None-Match": etag } : {}),
				},
			});
			// The timeout timer stays live until the BODY is consumed below.
			// Clearing it on headers let an upstream that stalls mid-body hang
			// json() (and every coalesced single-flight caller) indefinitely.
			if (res.status === 304) {
				clearTimeout(timer);
				return { data: undefined as T, etag: etag ?? null, notModified: true };
			}
			if (res.status === 404) {
				const err = new Error(`Not found: ${url}`) as Error & { code: string };
				err.code = "E_NOT_FOUND_UPSTREAM";
				throw err;
			}
			if (res.status === 429 || res.status >= 500) {
				const retryAfter = res.headers.get("Retry-After");
				const wait = retryAfter
					? Math.min(Number.parseInt(retryAfter, 10) * 1000 || 2000, 15000)
					: Math.min(500 * 2 ** attempt + Math.random() * 250, 8000);
				lastErr = new Error(`Upstream ${res.status} for ${url}`);
				if (attempt < retries) {
					clearTimeout(timer);
					await sleep(wait);
					continue;
				}
				throw lastErr;
			}
			if (!res.ok) {
				const err = new Error(`Upstream ${res.status} for ${url}`) as Error & {
					code: string;
				};
				err.code = "E_FETCH";
				throw err;
			}
			const json = await res.json();
			clearTimeout(timer);
			return {
				data: validate(json),
				etag: res.headers.get("ETag"),
				notModified: false,
			};
		} catch (err) {
			clearTimeout(timer);
			if ((err as { code?: string }).code === "E_NOT_FOUND_UPSTREAM") throw err;
			if ((err as Error).name === "AbortError") {
				lastErr = new Error(`Timeout fetching ${url}`);
			} else {
				lastErr = err;
			}
			if (
				attempt < retries &&
				(!(err as { code?: string }).code ||
					(err as { code?: string }).code === "E_FETCH")
			) {
				// Only retry network/timeout errors here (429/5xx handled above).
				if ((err as { code?: string }).code === "E_FETCH") throw err;
				await sleep(Math.min(500 * 2 ** attempt + Math.random() * 250, 8000));
				continue;
			}
			throw lastErr;
		}
	}
	throw lastErr;
}

export function fetchAllTerms(
	opts?: FetchOptions,
	fetchFn?: typeof fetch,
): Promise<FetchResult<RawTerm[]>> {
	return fetchJson(
		`${apiBase()}/term/all`,
		(u) => rawTermSchema.array().parse(u),
		opts,
		fetchFn,
	);
}

export function fetchCurrentTerm(
	opts?: FetchOptions,
	fetchFn?: typeof fetch,
): Promise<FetchResult<RawTerm>> {
	return fetchJson(
		`${apiBase()}/term/current`,
		(u) => rawTermSchema.parse(u),
		opts,
		fetchFn,
	);
}

export function fetchSections(
	term: string,
	opts?: FetchOptions,
	fetchFn?: typeof fetch,
): Promise<FetchResult<RawSection[]>> {
	return fetchJson(
		`${apiBase()}/sections/${term}`,
		(u) => rawSectionsSchema.parse(u),
		opts,
		fetchFn,
	);
}

export function fetchOfferingHistory(
	term: string,
	opts?: FetchOptions,
	fetchFn?: typeof fetch,
): Promise<FetchResult<RawHistoryEntry[]>> {
	return fetchJson(
		`${apiBase()}/offering-history/${term}`,
		(u) => rawHistorySchema.parse(u),
		opts,
		fetchFn,
	);
}

export function fetchCourseAreas(
	opts?: FetchOptions,
	fetchFn?: typeof fetch,
): Promise<FetchResult<{ area: string; description: string }[]>> {
	return fetchJson(
		`${apiBase()}/course-areas`,
		(u) =>
			(u as unknown[]).map((x) => ({
				area: String((x as { area: string }).area),
				description: String((x as { description: string }).description),
			})),
		opts,
		fetchFn,
	);
}
