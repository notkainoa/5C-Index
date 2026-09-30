// 5C-Index proxy — response envelope: meta builder + transport headers.
//
// Freshness travels two ways:
//   - Transport (browsers/CDNs): ETag passthrough, Last-Modified=fetched_at,
//     Cache-Control, X-5C-Fetched-At, X-5C-Stale.
//   - Payload (agents): /meta/:term.json {etag, hash, fetched_at, count}.
// WinterCG only.

import { countSections, sha1Hex } from "./store.ts";
import type { CacheMeta } from "./store.ts";

export const PROXY_VERSION = "0.1.0";

/** Build the per-term meta record agents consume via /meta/:term.json. */
export async function buildMeta(
	body: string,
	etag: string | null,
	fetchedAt?: string,
): Promise<CacheMeta> {
	return {
		etag,
		hash: await sha1Hex(body),
		fetched_at: fetchedAt ?? new Date().toISOString(),
		count: countSections(body),
	};
}

/** CORS `*` applied to every API response (snapshot / meta / terms / errors). */
export function applyCors(h: Headers): Headers {
	h.set("access-control-allow-origin", "*");
	h.set("access-control-allow-methods", "GET, OPTIONS");
	h.set("access-control-allow-headers", "*");
	return h;
}

export function corsPreflightHeaders(): Headers {
	const h = new Headers();
	applyCors(h);
	h.set("access-control-max-age", "86400");
	return h;
}

export interface SnapshotHeaderOpts {
	/** Current term: 60 s public + 30 s SWR. Past terms: immutable-ish day. */
	current: boolean;
	/** True when the body is served past its TTL (SWR / stale-only mode). */
	stale: boolean;
}

/** Transport headers for a 200 snapshot body. ETag passes through untouched. */
export function snapshotHeaders(
	meta: CacheMeta,
	opts: SnapshotHeaderOpts,
): Headers {
	const h = new Headers();
	h.set("content-type", "application/json");
	if (meta.etag) h.set("etag", meta.etag);
	h.set("last-modified", meta.fetched_at);
	h.set(
		"cache-control",
		opts.current
			? "public, max-age=60, stale-while-revalidate=30"
			: "public, max-age=86400, stale-while-revalidate=86400, immutable",
	);
	h.set("x-5c-fetched-at", meta.fetched_at);
	h.set("x-5c-stale", opts.stale ? "true" : "false");
	applyCors(h);
	return h;
}

/** 5-minute negative headers for unpublished (404) terms. */
export function negativeHeaders(): Headers {
	const h = new Headers();
	h.set("content-type", "application/json");
	h.set("cache-control", "public, max-age=300");
	applyCors(h);
	return h;
}

/** CLI-shaped error envelope: {ok:false, error:{code, message[, hint]}}. */
export function errorBody(
	code: string,
	message: string,
	hint?: string,
): unknown {
	return hint
		? { ok: false, error: { code, message, hint } }
		: { ok: false, error: { code, message } };
}

/** JSON error Response with CORS (so browsers can read the envelope). */
export function jsonError(
	status: number,
	code: string,
	message: string,
	hint?: string,
	extraHeaders?: Record<string, string>,
): Response {
	const h = new Headers({ "content-type": "application/json" });
	applyCors(h);
	if (extraHeaders) {
		for (const [k, v] of Object.entries(extraHeaders)) h.set(k, v);
	}
	return new Response(JSON.stringify(errorBody(code, message, hint)), {
		status,
		headers: h,
	});
}
