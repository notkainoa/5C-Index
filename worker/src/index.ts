// 5C-Index proxy — router.
//
//   GET /snapshot/:term.json  full term snapshot (SWR for the current term)
//   GET /meta/:term.json      {etag, hash, fetched_at, count} for agents
//   GET /terms                proxied + cached term catalog
//   GET /healthz              liveness
//
// Everything else: 404 JSON envelope {ok:false, error:{code, message}}.
// CORS `*` on snapshot / meta / terms (and on error envelopes so browsers
// can read them). Per-IP fixed-window rate limit: 60 req/min, 429 +
// Retry-After with a CLI-shaped body.
//
// WinterCG only (no node: imports).

import { singleFlight } from "./coalesce.ts";
import {
	PROXY_VERSION,
	buildMeta,
	corsPreflightHeaders,
	errorBody,
	jsonError,
	negativeHeaders,
	snapshotHeaders,
} from "./envelope.ts";
import { scheduled as runScheduled } from "./prewarm.ts";
import type { ScheduledEventLike } from "./prewarm.ts";
import { R2KVStorage, TERMS_CACHE_KEY, negKey } from "./store.ts";
import type { CacheMeta, Env, WorkerStorage } from "./store.ts";
import { fetchBanana, isStaleOnly } from "./upstream.ts";

export interface HandlerDeps {
	/** Injectable origin fetch (smoke tests script 304/404/500 here). */
	fetchFn?: typeof fetch;
	/** Injectable clock (smoke tests control TTL boundaries). */
	now?: () => number;
	/** Injectable storage (defaults to R2KVStorage over env). */
	storage?: WorkerStorage;
}

export interface CtxLike {
	waitUntil(p: Promise<unknown>): void;
}

const TERM_RE = /^(FA|SP|SU)\d{4}$/;
const SNAPSHOT_RE = /^\/snapshot\/([^/]+)\.json$/;
const META_RE = /^\/meta\/([^/]+)\.json$/;

const RATE_MAX = 60;
const WINDOW_MS = 60_000;
const CURRENT_TTL_MS = 60_000; // seats volatility: 60 s, SWR 30 s
const NEG_TTL_MS = 5 * 60_000; // unpublished terms rechecked every 5 min
const TERMS_TTL_MS = 600_000; // term catalog: 10 min edge cache

// --- Per-IP fixed-window rate limiter (per-isolate; see README) ---

interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Test escape hatch. */
export function resetRateLimits(): void {
	buckets.clear();
}

function clientIp(req: Request): string {
	return (
		req.headers.get("cf-connecting-ip") ??
		req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		"unknown"
	);
}

function rateCheck(
	ip: string,
	now: number,
): { allowed: boolean; retryAfterSec: number } {
	if (buckets.size > 10_000) {
		for (const [k, v] of buckets) {
			if (now >= v.resetAt) buckets.delete(k);
		}
	}
	const cur = buckets.get(ip);
	if (!cur || now >= cur.resetAt) {
		buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
		return { allowed: true, retryAfterSec: 0 };
	}
	cur.count += 1;
	if (cur.count > RATE_MAX) {
		return {
			allowed: false,
			retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)),
		};
	}
	return { allowed: true, retryAfterSec: 0 };
}

// --- Snapshot fetch + store (single-flight callers share this promise) ---

async function refreshSnapshot(
	term: string,
	current: boolean,
	store: WorkerStorage,
	prevMeta: CacheMeta | null,
	staleBody: string | null,
	deps: HandlerDeps,
	now: number,
): Promise<Response> {
	// Circuit open + something to serve: stale-only mode, no origin call.
	if (isStaleOnly() && staleBody !== null && prevMeta !== null) {
		return new Response(staleBody, {
			status: 200,
			headers: snapshotHeaders(prevMeta, { current, stale: true }),
		});
	}

	let res: Awaited<ReturnType<typeof fetchBanana>> | undefined;
	try {
		res = await fetchBanana(`/v4/sections/${term}`, {
			etag: prevMeta?.etag ?? null,
			fetchFn: deps.fetchFn,
		});
	} catch {
		if (staleBody !== null && prevMeta !== null) {
			return new Response(staleBody, {
				status: 200,
				headers: snapshotHeaders(prevMeta, { current, stale: true }),
			});
		}
		throw new Error("upstream unreachable");
	}

	if (res.status === 304 && staleBody !== null && prevMeta !== null) {
		// Origin confirms our copy: bump fetched_at, keep serving it.
		const bumped: CacheMeta = {
			...prevMeta,
			fetched_at: new Date(now).toISOString(),
		};
		await store.metaPut(term, bumped);
		return new Response(staleBody, {
			status: 200,
			headers: snapshotHeaders(bumped, { current, stale: false }),
		});
	}

	if (res.status === 200 && res.body !== null) {
		const meta = await buildMeta(
			res.body,
			res.etag,
			new Date(now).toISOString(),
		);
		await store.snapshotPut(term, res.body, res.etag);
		await store.metaPut(term, meta);
		await store.kvDelete(negKey(term));
		return new Response(res.body, {
			status: 200,
			headers: snapshotHeaders(meta, { current, stale: false }),
		});
	}

	if (res.status === 404) {
		await store.kvPut(negKey(term), String(now), { expirationTtl: 300 });
		return new Response(
			JSON.stringify(
				errorBody(
					"E_TERM_NOT_FOUND",
					`Term ${term} is not published upstream.`,
				),
			),
			{ status: 404, headers: negativeHeaders() },
		);
	}

	// 429 / 5xx after retries (or unexpected status): stale if we have it.
	if (staleBody !== null && prevMeta !== null) {
		return new Response(staleBody, {
			status: 200,
			headers: snapshotHeaders(prevMeta, { current, stale: true }),
		});
	}
	throw new Error(`upstream status ${res.status}`);
}

function termNotFound(term: string): Response {
	return new Response(
		JSON.stringify(
			errorBody("E_TERM_NOT_FOUND", `Term ${term} is not published upstream.`),
		),
		{ status: 404, headers: negativeHeaders() },
	);
}

async function handleSnapshot(
	term: string,
	req: Request,
	env: Env,
	ctx: CtxLike,
	deps: HandlerDeps,
	now: number,
): Promise<Response> {
	if (!TERM_RE.test(term)) {
		return jsonError(
			404,
			"E_BAD_TERM",
			`Invalid term "${term}".`,
			"Use FA/SP/SU + year, e.g. FA2026. See /terms for the catalog.",
		);
	}
	const store = deps.storage ?? new R2KVStorage(env);
	const current = env.CURRENT_TERM ? term === env.CURRENT_TERM : true;

	// 5-minute negative cache for unpublished terms.
	const negRaw = await store.kvGet(negKey(term));
	if (negRaw !== null && now - Number(negRaw) < NEG_TTL_MS) {
		return termNotFound(term);
	}

	const cached = await store.snapshotGet(term);
	const meta = await store.metaGet(term);

	if (cached && meta) {
		// Client-side conditional: ETag passes straight through.
		const inm = req.headers.get("if-none-match");
		if (inm && meta.etag && inm === meta.etag) {
			return new Response(null, {
				status: 304,
				headers: snapshotHeaders(meta, { current, stale: false }),
			});
		}
		const age = now - Date.parse(meta.fetched_at);
		const fresh = current ? age < CURRENT_TTL_MS : true; // past terms: immutable
		if (fresh) {
			return new Response(cached.body, {
				status: 200,
				headers: snapshotHeaders(meta, { current, stale: false }),
			});
		}
		if (current) {
			// SWR: serve the stale copy now, refresh in the background.
			ctx.waitUntil(
				singleFlight(`snapshot:${term}`, () =>
					refreshSnapshot(term, current, store, meta, cached.body, deps, now),
				).catch(() => null),
			);
			return new Response(cached.body, {
				status: 200,
				headers: snapshotHeaders(meta, { current, stale: true }),
			});
		}
		return new Response(cached.body, {
			status: 200,
			headers: snapshotHeaders(meta, { current, stale: false }),
		});
	}

	// Miss (or body without meta): coalesced origin fetch across concurrent waiters.
	// NOTE: every waiter shares one in-flight promise, hence one Response
	// object — clone per caller so each body stream is independently readable.
	try {
		const shared = await singleFlight(`snapshot:${term}`, () =>
			refreshSnapshot(
				term,
				current,
				store,
				meta,
				cached?.body ?? null,
				deps,
				now,
			),
		);
		return shared.clone();
	} catch {
		return jsonError(
			502,
			"E_UPSTREAM",
			"Upstream unavailable and no cached snapshot for this term.",
			"Retry shortly; the 2-minute prewarm usually restores the snapshot within a minute.",
		);
	}
}

async function handleMeta(
	term: string,
	env: Env,
	deps: HandlerDeps,
): Promise<Response> {
	if (!TERM_RE.test(term)) {
		return jsonError(
			404,
			"E_BAD_TERM",
			`Invalid term "${term}".`,
			"Use FA/SP/SU + year, e.g. FA2026. See /terms for the catalog.",
		);
	}
	const store = deps.storage ?? new R2KVStorage(env);
	const meta = await store.metaGet(term);
	if (!meta) {
		return jsonError(
			404,
			"E_NOT_FOUND",
			`No metadata for term ${term} yet.`,
			"Fetch /snapshot/:term.json first, or check /terms for the catalog.",
		);
	}
	const h = new Headers({
		"content-type": "application/json",
		"cache-control": "public, max-age=60, stale-while-revalidate=30",
	});
	// CORS: meta is consumed by browser frontends and agents alike.
	h.set("access-control-allow-origin", "*");
	h.set("access-control-allow-methods", "GET, OPTIONS");
	h.set("access-control-allow-headers", "*");
	return new Response(JSON.stringify(meta), { status: 200, headers: h });
}

function termsResponse(body: string, stale: boolean): Response {
	const h = new Headers({
		"content-type": "application/json",
		"cache-control": "public, max-age=600, stale-while-revalidate=86400",
		"x-5c-stale": stale ? "true" : "false",
	});
	h.set("access-control-allow-origin", "*");
	h.set("access-control-allow-methods", "GET, OPTIONS");
	h.set("access-control-allow-headers", "*");
	return new Response(body, { status: 200, headers: h });
}

async function handleTerms(
	env: Env,
	deps: HandlerDeps,
	now: number,
): Promise<Response> {
	const store = deps.storage ?? new R2KVStorage(env);
	const raw = await store.kvGet(TERMS_CACHE_KEY);
	if (raw !== null) {
		try {
			const entry = JSON.parse(raw) as { body: string; fetched_at: string };
			if (now - Date.parse(entry.fetched_at) < TERMS_TTL_MS) {
				return termsResponse(entry.body, false);
			}
		} catch {
			// Corrupt entry: refetch below.
		}
	}
	try {
		const res = await fetchBanana("/v4/term/all", { fetchFn: deps.fetchFn });
		if (res.status === 200 && res.body !== null) {
			await store.kvPut(
				TERMS_CACHE_KEY,
				JSON.stringify({
					body: res.body,
					fetched_at: new Date(now).toISOString(),
				}),
				{ expirationTtl: 3600 },
			);
			return termsResponse(res.body, false);
		}
	} catch {
		// Fall through to stale.
	}
	if (raw !== null) {
		try {
			return termsResponse((JSON.parse(raw) as { body: string }).body, true);
		} catch {
			// Fall through to 502.
		}
	}
	return jsonError(
		502,
		"E_UPSTREAM",
		"Could not load the term catalog.",
		"Retry shortly.",
	);
}

/** Router entrypoint (unit-testable; the default export wires the runtime). */
export async function handleRequest(
	request: Request,
	env: Env,
	ctx: CtxLike,
	deps: HandlerDeps = {},
): Promise<Response> {
	const now = deps.now ? deps.now() : Date.now();

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsPreflightHeaders() });
	}
	if (request.method !== "GET") {
		return jsonError(
			405,
			"E_METHOD_NOT_ALLOWED",
			`Method ${request.method} not allowed.`,
			"Use GET.",
		);
	}

	const limited = rateCheck(clientIp(request), now);
	if (!limited.allowed) {
		return jsonError(
			429,
			"E_RATE_LIMITED",
			"Rate limit exceeded: 60 requests per minute per IP.",
			`Retry after ${limited.retryAfterSec}s.`,
			{ "retry-after": String(limited.retryAfterSec) },
		);
	}

	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/healthz") {
		return new Response(
			JSON.stringify({
				ok: true,
				version: PROXY_VERSION,
				time: new Date(now).toISOString(),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}
	if (path === "/terms") {
		return handleTerms(env, deps, now);
	}
	const snap = SNAPSHOT_RE.exec(path);
	if (snap) {
		return handleSnapshot(snap[1] as string, request, env, ctx, deps, now);
	}
	const meta = META_RE.exec(path);
	if (meta) {
		return handleMeta(meta[1] as string, env, deps);
	}
	return jsonError(
		404,
		"E_NOT_FOUND",
		`No route for ${path}.`,
		"Try /snapshot/:term.json, /meta/:term.json, /terms, or /healthz.",
	);
}

export default {
	async fetch(request: Request, env: Env, ctx: CtxLike): Promise<Response> {
		return handleRequest(request, env, ctx);
	},
	async scheduled(event: ScheduledEventLike, env: Env): Promise<void> {
		await runScheduled(event, env);
	},
};
