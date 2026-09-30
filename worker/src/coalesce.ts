// 5C-Index proxy — request coalescing (thundering-herd protection).
//
// Two layers:
//   1. Isolate-local single-flight: concurrent misses for the same term in
//      one isolate share one upstream fetch (in-flight Map).
//   2. Cross-isolate KV flag: a 30 s TTL marker so a second isolate that
//      misses while the first is still fetching can observe in-flight work.
//      (KV is eventually consistent; this is best-effort. A Durable Object
//      singleton would be exact — see README open questions.)
//
// WinterCG only.

import type { KVStore } from "./store.ts";

const inFlight = new Map<string, Promise<unknown>>();

export function inflightKey(term: string): string {
	return `inflight:${term}`;
}

/**
 * Run fn once per key: concurrent callers with the same key share the
 * in-progress promise. The entry is removed on settle (success or throw).
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = inFlight.get(key);
	if (existing) return existing as Promise<T>;
	const p = fn().finally(() => {
		if (inFlight.get(key) === p) inFlight.delete(key);
	});
	inFlight.set(key, p);
	return p;
}

/** Test escape hatch: drop all in-flight entries. */
export function clearInFlight(): void {
	inFlight.clear();
}

/**
 * Best-effort cross-isolate guard. Returns true when this isolate won the
 * fetch (flag set with 30 s TTL), false when another isolate holds it.
 */
export async function kvAcquire(
	kv: KVStore,
	term: string,
	ttlSec = 30,
): Promise<boolean> {
	const current = await kv.kvGet(inflightKey(term));
	if (current !== null) return false;
	await kv.kvPut(inflightKey(term), String(Date.now()), {
		expirationTtl: ttlSec,
	});
	return true;
}

/** Release the cross-isolate flag after the fetch settles. */
export async function kvRelease(kv: KVStore, term: string): Promise<void> {
	await kv.kvDelete(inflightKey(term));
}
