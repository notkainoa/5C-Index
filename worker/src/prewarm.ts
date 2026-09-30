// 5C-Index proxy — cron prewarm (exported scheduled handler).
//
// Two cron classes, distinguished by the cron expression (see wrangler.toml):
//   - Quick cadence (expression starts with "*/2"): refresh ONLY the current
//     term. Runs every 2 min so the hot snapshot never goes stale.
//   - Daily cron (anything else): full prewarm — term catalog, every listed
//     term snapshot, and the course-areas dictionary. Writes R2 + KV.
//
// All origin reads go through fetchBanana (conditional ETag, retries,
// breaker); all writes go through WorkerStorage. Never throws: a failed
// prewarm leaves the previous snapshot in place.
//
// WinterCG only.

import { buildMeta } from "./envelope.ts";
import { R2KVStorage, TERMS_CACHE_KEY } from "./store.ts";
import type { Env } from "./store.ts";
import { fetchBanana } from "./upstream.ts";

export interface ScheduledEventLike {
	cron: string;
	scheduledTime?: number;
}

export interface PrewarmDeps {
	fetchFn?: typeof fetch;
	now?: () => number;
}

/** Quick-cadence cron = expression starting with "*\/2" (every-2-min slot). */
export function isQuickCron(cron: string): boolean {
	return cron.trim().startsWith("*/2");
}

interface TermEntry {
	term: string;
	year: number;
}

function termName(t: TermEntry): string {
	return `${t.term}${t.year}`;
}

/** Resolve the current term: [vars] first, then /term/current, then max of /term/all. */
export async function resolveCurrentTerm(
	env: Env,
	fetchFn?: typeof fetch,
): Promise<string> {
	if (env.CURRENT_TERM) return env.CURRENT_TERM;
	try {
		const res = await fetchBanana("/v4/term/current", { fetchFn });
		if (res.status === 200 && res.body) {
			const v = JSON.parse(res.body) as { term?: unknown; year?: unknown };
			if (typeof v.term === "string" && typeof v.year === "number") {
				return `${v.term}${v.year}`;
			}
		}
	} catch {
		// Fall through to term/all.
	}
	try {
		const res = await fetchBanana("/v4/term/all", { fetchFn });
		if (res.status === 200 && res.body) {
			const names = (JSON.parse(res.body) as TermEntry[]).map(termName).sort();
			if (names.length > 0) return names[names.length - 1] as string;
		}
	} catch {
		// Fall through to last-resort default.
	}
	return "FA2026";
}

/** Conditional refresh of one term snapshot (no-op on 304 content, writes R2+KV on 200). */
export async function refreshTerm(
	term: string,
	env: Env,
	deps: PrewarmDeps = {},
): Promise<void> {
	const store = new R2KVStorage(env);
	const now = deps.now ? deps.now() : Date.now();
	const prev = await store.metaGet(term);
	let res: Awaited<ReturnType<typeof fetchBanana>> | undefined;
	try {
		res = await fetchBanana(`/v4/sections/${term}`, {
			etag: prev?.etag ?? null,
			fetchFn: deps.fetchFn,
		});
	} catch {
		return; // Leave previous snapshot in place.
	}
	if (res.status === 304 && prev) {
		await store.metaPut(term, {
			...prev,
			fetched_at: new Date(now).toISOString(),
		});
		return;
	}
	if (res.status === 200 && res.body !== null) {
		await store.snapshotPut(term, res.body, res.etag);
		await store.metaPut(
			term,
			await buildMeta(res.body, res.etag, new Date(now).toISOString()),
		);
	}
	// 404 / 5xx: leave previous state untouched (router owns negative caching).
}

/**
 * Full prewarm: cache the term catalog, refresh every listed term, and
 * refresh the course-areas dictionary. Sequential per term (politeness:
 * at most one in-flight upstream request from this isolate).
 */
export async function fullPrewarm(
	env: Env,
	deps: PrewarmDeps = {},
): Promise<{ terms: string[] }> {
	const store = new R2KVStorage(env);
	const now = deps.now ? deps.now() : Date.now();

	let terms: string[] = [];
	try {
		const res = await fetchBanana("/v4/term/all", { fetchFn: deps.fetchFn });
		if (res.status === 200 && res.body !== null) {
			await store.kvPut(
				TERMS_CACHE_KEY,
				JSON.stringify({
					body: res.body,
					fetched_at: new Date(now).toISOString(),
				}),
				{ expirationTtl: 86400 },
			);
			try {
				terms = (JSON.parse(res.body) as TermEntry[]).map(termName);
			} catch {
				terms = [];
			}
		}
	} catch {
		// Leave previous catalog in place.
	}

	for (const term of terms) {
		await refreshTerm(term, env, deps);
	}

	try {
		const areas = await fetchBanana("/v4/course-areas", {
			fetchFn: deps.fetchFn,
		});
		if (areas.status === 200 && areas.body !== null) {
			await store.snapshotPut("course-areas", areas.body, areas.etag);
			await store.metaPut(
				"course-areas",
				await buildMeta(areas.body, areas.etag, new Date(now).toISOString()),
			);
		}
	} catch {
		// Leave previous dictionary in place.
	}

	return { terms };
}

/** Cron entrypoint (wired to `scheduled` in index.ts). */
export async function scheduled(
	event: ScheduledEventLike,
	env: Env,
	deps: PrewarmDeps = {},
): Promise<void> {
	if (isQuickCron(event.cron)) {
		await refreshTerm(await resolveCurrentTerm(env, deps.fetchFn), env, deps);
		return;
	}
	await fullPrewarm(env, deps);
}
