// 5C-Index proxy — storage: R2 snapshots + KV metadata.
//
// WinterCG only. Two implementations behind one interface:
//   - R2KVStorage: production adapter over env.SNAPSHOTS (R2) + env.META (KV)
//   - MemoryStorage: identical semantics over Maps (local smoke tests, prewarm tests)
// Interfaces are structural and minimal so no @cloudflare/workers-types
// dependency is needed.

/** Per-term cache metadata — the machine-readable freshness record. */
export interface CacheMeta {
	/** Upstream ETag (weak or strong), passed through to clients. */
	etag: string | null;
	/** sha1 hex of the raw snapshot body; index rebuilds when this changes. */
	hash: string;
	/** ISO timestamp of the last successful upstream validation/fetch. */
	fetched_at: string;
	/** Section count (JSON array length, 0 when unparseable). */
	count: number;
}

// --- Minimal structural bindings (subset of the Workers runtime API) ---

export interface KVNamespaceLike {
	get(key: string, type: "text"): Promise<string | null>;
	get(key: string, type: "json"): Promise<unknown>;
	put(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface R2ObjectLike {
	text(): Promise<string>;
	httpEtag?: string | null;
}

export interface R2BucketLike {
	get(key: string): Promise<R2ObjectLike | null>;
	put(
		key: string,
		value: string,
		opts?: { httpEtag?: string },
	): Promise<unknown>;
}

export interface Env {
	SNAPSHOTS: R2BucketLike;
	META: KVNamespaceLike;
	/** Canonical current term, e.g. "FA2026". Set via [vars] in wrangler.toml. */
	CURRENT_TERM?: string;
}

// --- Shared key layout (router, prewarm and tests must agree) ---

export function snapshotKey(key: string): string {
	return `snapshot/${key}.json`;
}

export function metaKey(key: string): string {
	return `meta:${key}`;
}

export function negKey(term: string): string {
	return `neg:${term}`;
}

export const TERMS_CACHE_KEY = "terms:all";

/** Snapshot payload + the ETag it was stored with. */
export interface Snapshot {
	body: string;
	etag: string | null;
}

export interface Storage {
	snapshotGet(key: string): Promise<Snapshot | null>;
	snapshotPut(key: string, body: string, etag: string | null): Promise<void>;
	metaGet(key: string): Promise<CacheMeta | null>;
	metaPut(key: string, meta: CacheMeta): Promise<void>;
}

/** Raw KV access for flags with TTL (coalescing, negative cache, terms). */
export interface KVStore {
	kvGet(key: string): Promise<string | null>;
	kvPut(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void>;
	kvDelete(key: string): Promise<void>;
}

export type WorkerStorage = Storage & KVStore;

/** Production adapter: R2 holds bodies, KV holds meta + flags. */
export class R2KVStorage implements WorkerStorage {
	private env: Env;

	constructor(env: Env) {
		this.env = env;
	}

	async snapshotGet(key: string): Promise<Snapshot | null> {
		const obj = await this.env.SNAPSHOTS.get(snapshotKey(key));
		if (!obj) return null;
		return { body: await obj.text(), etag: obj.httpEtag ?? null };
	}

	async snapshotPut(
		key: string,
		body: string,
		etag: string | null,
	): Promise<void> {
		await this.env.SNAPSHOTS.put(
			snapshotKey(key),
			body,
			etag ? { httpEtag: etag } : undefined,
		);
	}

	async metaGet(key: string): Promise<CacheMeta | null> {
		const raw = await this.env.META.get(metaKey(key), "json");
		if (!raw || typeof raw !== "object") return null;
		const m = raw as Record<string, unknown>;
		if (typeof m.hash !== "string" || typeof m.fetched_at !== "string")
			return null;
		return {
			etag: typeof m.etag === "string" ? (m.etag as string) : null,
			hash: m.hash as string,
			fetched_at: m.fetched_at as string,
			count: typeof m.count === "number" ? (m.count as number) : 0,
		};
	}

	async metaPut(key: string, meta: CacheMeta): Promise<void> {
		await this.env.META.put(metaKey(key), JSON.stringify(meta));
	}

	async kvGet(key: string): Promise<string | null> {
		return this.env.META.get(key, "text");
	}

	async kvPut(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void> {
		await this.env.META.put(key, value, opts);
	}

	async kvDelete(key: string): Promise<void> {
		await this.env.META.delete(key);
	}
}

interface KvEntry {
	value: string;
	expiresAt: number; // 0 = no expiry
}

/** In-memory twin of R2KVStorage for node smoke tests. */
export class MemoryStorage implements WorkerStorage {
	private snapshots = new Map<string, Snapshot>();
	private metas = new Map<string, CacheMeta>();
	private kv = new Map<string, KvEntry>();

	async snapshotGet(key: string): Promise<Snapshot | null> {
		return this.snapshots.get(key) ?? null;
	}

	async snapshotPut(
		key: string,
		body: string,
		etag: string | null,
	): Promise<void> {
		this.snapshots.set(key, { body, etag });
	}

	async metaGet(key: string): Promise<CacheMeta | null> {
		return this.metas.get(key) ?? null;
	}

	async metaPut(key: string, meta: CacheMeta): Promise<void> {
		this.metas.set(key, { ...meta });
	}

	async kvGet(key: string): Promise<string | null> {
		const e = this.kv.get(key);
		if (!e) return null;
		if (e.expiresAt !== 0 && Date.now() > e.expiresAt) {
			this.kv.delete(key);
			return null;
		}
		return e.value;
	}

	async kvPut(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void> {
		this.kv.set(key, {
			value,
			expiresAt: opts?.expirationTtl
				? Date.now() + opts.expirationTtl * 1000
				: 0,
		});
	}

	async kvDelete(key: string): Promise<void> {
		this.kv.delete(key);
	}
}

/** sha1 hex via WebCrypto (available in Workers and node 24). */
export async function sha1Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-1",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Section count of a snapshot body (JSON array length; 0 when unparseable). */
export function countSections(body: string): number {
	try {
		const parsed: unknown = JSON.parse(body);
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}
