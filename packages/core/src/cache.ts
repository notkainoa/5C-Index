import { createHash } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiBase, fetchJson, fetchOfferingHistory } from "./hyperschedule.js";
import { normalizeSection } from "./normalize.js";
import {
	cacheMetaSchema,
	rawHistorySchema,
	rawSectionSchema,
	rawSectionsSchema,
	sectionSchema,
} from "./schema.js";
import type {
	CacheMeta,
	RawHistoryEntry,
	RawSection,
	Section,
} from "./schema.js";

/**
 * Snapshot cache: one whole-term JSON file + meta file.
 * Layout:  $FIVE_C_DATA_DIR | ~/.5c-index/cache/<TERM>.json + <TERM>.meta.json
 * In-memory Map so repeated in-process queries never touch disk.
 *
 * Reliability guarantees (post-audit):
 * - Every disk read is validated (section schema + non-empty + count
 *   tolerance) and hash-checked (sha1(data) === meta.hash). Invalid reads
 *   are treated as a miss and trigger a full refetch (etag discarded) —
 *   poison can never perpetuate.
 * - All writes are atomic (tmp + fsync + rename, data-before-meta).
 * - 304 revalidation re-reads through the same validating path and retries
 *   once with a full fetch on failure.
 */

export const SEAT_TTL_MS = 60_000;
export const SCHEDULE_TTL_MS = 30 * 60_000;
export const HISTORY_TTL_MS = 24 * 60 * 60_000;
export const CURRENT_TERM_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 5 * 60_000;
const HISTORY_MEM_CAP = 8;

export function cacheDir(): string {
	const override =
		process.env.FIVE_C_DATA_DIR ?? process.env.FIVE_C_CACHE_DIR ?? null;
	return override ?? join(homedir(), ".5c-index", "cache");
}

function files(term: string) {
	const dir = cacheDir();
	return {
		dir,
		data: join(dir, `${term}.json`),
		meta: join(dir, `${term}.meta.json`),
		history: join(dir, `${term}.history.json`),
		neg: join(dir, `${term}.neg.json`),
	};
}

export function currentTermFile(): string {
	return join(cacheDir(), "current-term.json");
}

export function sha1(s: string): string {
	return createHash("sha1").update(s).digest("hex");
}

const mem = new Map<string, { sections: Section[]; meta: CacheMeta }>();
const memHistory = new Map<
	string,
	{ entries: RawHistoryEntry[]; fetched_at: string }
>();
const negative = new Map<string, number>(); // term -> 404 timestamp

// In-flight single-flight dedup (per-process stampede guard).
const inflightRefresh = new Map<
	string,
	Promise<{ sections: Section[]; meta: CacheMeta }>
>();
const inflightHistory = new Map<
	string,
	Promise<{ entries: RawHistoryEntry[]; fetched_at: string; stale: boolean }>
>();

// Current-term memo (mem mirror of current-term.json; owned here so
// refreshTerm can refresh it without a circular import into index.ts).
let currentTermMem: { value: string; at: number } | null = null;
export function getCurrentTermMem(): { value: string; at: number } | null {
	return currentTermMem;
}
export function setCurrentTermMem(value: string, at: number): void {
	currentTermMem = { value, at };
}
export function clearCurrentTermMem(): void {
	currentTermMem = null;
}

export function clearMemoryCache(): void {
	mem.clear();
	memHistory.clear();
	negative.clear();
}

function isStale(meta: CacheMeta): boolean {
	const t = Date.parse(meta.fetched_at);
	if (!Number.isFinite(t)) return true;
	const age = Date.now() - t;
	// Future-dated or non-finite fetched_at must never read as fresh forever.
	if (!Number.isFinite(age) || age < 0) return true;
	return age > SEAT_TTL_MS;
}

function historyIsStale(fetched_at: string): boolean {
	const t = Date.parse(fetched_at);
	if (!Number.isFinite(t)) return true;
	const age = Date.now() - t;
	if (!Number.isFinite(age) || age < 0) return true;
	return age > HISTORY_TTL_MS;
}

function nowISO(): string {
	return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Atomic write: tmp file + fsync + rename. */
async function atomicWrite(path: string, content: string): Promise<void> {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmp, content);
	try {
		const fh = await open(tmp, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await rename(tmp, path);
	} catch {
		try {
			await unlink(tmp);
		} catch {
			// best-effort cleanup
		}
		throw new Error(`Atomic write failed for ${path}`);
	}
}

/** Allowed drift between meta.count and actual sections on disk. */
function countTolerance(metaCount: number): number {
	return Math.max(10, Math.floor(metaCount * 0.1));
}

/**
 * Validate a snapshot read: meta must parse, sections must be a non-empty
 * schema-valid array, and the count must be within tolerance of meta.count.
 * Returns null on ANY mismatch (poison reads as miss, never as fresh).
 */
export function validateSnapshot(
	sections: unknown,
	meta: unknown,
): { sections: Section[]; meta: CacheMeta } | null {
	const m = cacheMetaSchema.safeParse(meta);
	if (!m.success) return null;
	const s = sectionSchema.array().safeParse(sections);
	if (!s.success) return null;
	if (s.data.length === 0) return null;
	if (Math.abs(s.data.length - m.data.count) > countTolerance(m.data.count)) {
		return null;
	}
	return { sections: s.data, meta: m.data };
}

/**
 * Per-section quarantine at ingest: try the fast whole-array parse first;
 * on failure keep individually-valid sections and count the rejects.
 * Never fails the whole term on one bad section.
 */
export function quarantineRawSections(data: unknown): {
	raw: RawSection[];
	quarantined: number;
} {
	const whole = rawSectionsSchema.safeParse(data);
	if (whole.success) return { raw: whole.data, quarantined: 0 };
	if (!Array.isArray(data)) return { raw: [], quarantined: 0 };
	const good: RawSection[] = [];
	let quarantined = 0;
	for (const item of data) {
		const r = rawSectionSchema.safeParse(item);
		if (r.success) good.push(r.data);
		else quarantined++;
	}
	return { raw: good, quarantined };
}

/**
 * Validating snapshot read: meta first, hash check (one 50ms retry on
 * mismatch — covers a concurrent atomic writer), then schema validation.
 * Returns null on any failure (caller treats as miss → full refetch).
 */
async function readSnapshot(
	T: string,
): Promise<{ sections: Section[]; meta: CacheMeta } | null> {
	const f = files(T);
	for (let attempt = 0; attempt < 2; attempt++) {
		let metaRaw: string;
		let dataRaw: string;
		try {
			metaRaw = await readFile(f.meta, "utf8");
			dataRaw = await readFile(f.data, "utf8");
		} catch {
			return null;
		}
		let metaParsed: unknown;
		try {
			metaParsed = JSON.parse(metaRaw);
		} catch {
			return null;
		}
		const meta = metaParsed as CacheMeta;
		if (typeof meta?.hash === "string" && sha1(dataRaw) !== meta.hash) {
			if (attempt === 0) {
				await sleep(50);
				continue;
			}
			return null;
		}
		let sectionsRaw: unknown;
		try {
			sectionsRaw = JSON.parse(dataRaw);
		} catch {
			// Truncated / invalid-JSON bytes: miss, never exit-1 poison.
			return null;
		}
		return validateSnapshot(sectionsRaw, metaParsed);
	}
	return null;
}

export async function loadTerm(
	term: string,
	opts: { allowStale?: boolean; fetchFn?: typeof fetch } = {},
): Promise<{ sections: Section[]; meta: CacheMeta }> {
	const T = term.toUpperCase();
	const cached = mem.get(T);
	if (cached) {
		if (cached.sections.length === 0) {
			// Empty memory entry can never satisfy a read (F1).
			mem.delete(T);
		} else if (!isStale(cached.meta)) {
			return cached;
		}
		// Stale mem: fall through to validated disk first (another process may
		// have healed the file); stale mem remains the last-resort below.
	}
	// Validated disk before network.
	const disk = await readSnapshot(T);
	if (disk) {
		disk.meta.stale = isStale(disk.meta);
		disk.meta.source = disk.meta.stale ? "stale-cache" : "live";
		mem.set(T, disk);
		// Async revalidate when stale (fire-and-forget, errors swallowed).
		if (disk.meta.stale && opts.allowStale !== false) {
			void refreshTerm(T, { fetchFn: opts.fetchFn }).catch(() => {});
			return disk;
		}
		if (!disk.meta.stale) return disk;
		// Stale + no stale allowed -> fall through to refresh.
	} else {
		const staleMem = mem.get(T);
		if (staleMem && staleMem.sections.length > 0 && opts.allowStale !== false) {
			staleMem.meta.stale = true;
			staleMem.meta.source = "stale-cache";
			void refreshTerm(T, { fetchFn: opts.fetchFn }).catch(() => {});
			return staleMem;
		}
	}
	return refreshTerm(T, { fetchFn: opts.fetchFn });
}

async function readNegative(T: string): Promise<number | null> {
	const f = files(T);
	try {
		const raw = await readFile(f.neg, "utf8");
		const at = (JSON.parse(raw) as { at: number }).at;
		if (typeof at === "number" && Number.isFinite(at)) {
			if (Date.now() - at < NEGATIVE_TTL_MS) {
				negative.set(T, at);
				return at;
			}
			void unlink(f.neg).catch(() => {});
			negative.delete(T);
			return null;
		}
	} catch {
		// no (valid) negative file
	}
	const memAt = negative.get(T);
	if (memAt !== undefined) {
		if (Date.now() - memAt < NEGATIVE_TTL_MS) return memAt;
		negative.delete(T);
	}
	return null;
}

async function writeNegative(T: string): Promise<void> {
	const at = Date.now();
	negative.set(T, at);
	try {
		const f = files(T);
		await mkdir(f.dir, { recursive: true });
		await atomicWrite(f.neg, JSON.stringify({ at }));
	} catch {
		// mem entry still guards this process
	}
}

async function clearNegative(T: string): Promise<void> {
	negative.delete(T);
	try {
		await unlink(files(T).neg);
	} catch {
		// already absent
	}
}

function termNotFound(T: string): Error & { code: string } {
	return Object.assign(new Error(`Term ${T} not available upstream (404)`), {
		code: "E_TERM_NOT_FOUND",
	});
}

export async function refreshTerm(
	term: string,
	opts: { force?: boolean; fetchFn?: typeof fetch } = {},
): Promise<{ sections: Section[]; meta: CacheMeta }> {
	const T = term.toUpperCase();
	if (!opts.force) {
		const neg = await readNegative(T);
		if (neg !== null) {
			throw Object.assign(
				new Error(`Term ${T} recently 404'd upstream; retry shortly`),
				{ code: "E_TERM_NOT_FOUND" },
			);
		}
	}
	// Single-flight: concurrent refreshes for one term share one fetch.
	// Key includes force so a forced refresh never joins a conditional one.
	const key = opts.force ? `${T}:force` : T;
	const inflight = inflightRefresh.get(key);
	if (inflight) return inflight;
	const p = refreshTermInner(T, opts)
		.then((entry) => {
			inflightRefresh.delete(key);
			return entry;
		})
		.catch((err: unknown) => {
			inflightRefresh.delete(key);
			throw err;
		});
	inflightRefresh.set(key, p);
	return p;
}

async function refreshTermInner(
	T: string,
	opts: { force?: boolean; fetchFn?: typeof fetch },
): Promise<{ sections: Section[]; meta: CacheMeta }> {
	const f = files(T);
	let prevEtag: string | null = null;
	try {
		const metaRaw = await readFile(f.meta, "utf8");
		prevEtag = (JSON.parse(metaRaw) as CacheMeta).etag ?? null;
	} catch {
		// no previous etag
	}

	async function doFetch(etag: string | null) {
		// NOTE: intentionally NOT fetchSections — its strict whole-array
		// validate would throw on one bad section before quarantine can run.
		// Validation happens here at ingest via quarantineRawSections.
		return fetchJson(
			`${apiBase()}/sections/${T}`,
			(u) => u as RawSection[],
			{ etag: opts.force ? null : etag },
			opts.fetchFn,
		);
	}

	let res: Awaited<ReturnType<typeof doFetch>> | undefined;
	try {
		res = await doFetch(prevEtag);
	} catch (err) {
		if ((err as { code?: string }).code === "E_NOT_FOUND_UPSTREAM") {
			await writeNegative(T);
			// Serve last-good disk snapshot if it validates.
			const disk = await readSnapshot(T);
			if (disk) {
				disk.meta.stale = true;
				disk.meta.source = "offline-file";
				mem.set(T, disk);
				return disk;
			}
			throw termNotFound(T);
		}
		// Network failure: serve validated stale disk snapshot if present.
		const disk = await readSnapshot(T);
		if (disk) {
			disk.meta.stale = true;
			disk.meta.source = "offline-file";
			mem.set(T, disk);
			return disk;
		}
		throw err;
	}

	if (res === undefined || res.notModified) {
		// 304: re-read through the VALIDATING path — the bytes on disk may be
		// poison (empty/corrupt/stale-meta). On failure retry once with a full
		// fetch instead of rewriting meta fresh over bad data.
		const disk = await readSnapshot(T);
		if (!disk) {
			try {
				res = await doFetch(null);
			} catch (err) {
				if ((err as { code?: string }).code === "E_NOT_FOUND_UPSTREAM") {
					await writeNegative(T);
					throw termNotFound(T);
				}
				throw err;
			}
			if (res === undefined || res.notModified) {
				// Upstream still says 304 but we hold nothing valid.
				throw termNotFound(T);
			}
			return persistFresh(T, res.data, res.etag);
		}
		disk.meta.fetched_at = nowISO();
		disk.meta.stale = false;
		disk.meta.source = "live";
		await atomicWrite(f.meta, JSON.stringify(disk.meta, null, 1));
		mem.set(T, disk);
		return disk;
	}

	return persistFresh(T, res.data, res.etag);
}

/** Validate + quarantine + normalize + atomically persist a fresh payload. */
async function persistFresh(
	T: string,
	data: unknown,
	etag: string | null,
): Promise<{ sections: Section[]; meta: CacheMeta }> {
	const f = files(T);
	const { raw, quarantined } = quarantineRawSections(data);
	if (raw.length === 0) {
		// Whole payload unusable: never persist an empty snapshot (F1).
		// Serve last-good disk if present, else fail loudly.
		const disk = await readSnapshot(T);
		if (disk) {
			disk.meta.stale = true;
			disk.meta.source = "offline-file";
			mem.set(T, disk);
			return disk;
		}
		throw Object.assign(
			new Error(`Upstream payload for term ${T} contained no usable sections`),
			{ code: "E_FETCH" },
		);
	}
	const sections = raw.map(normalizeSection).filter((s) => s.term === T);
	if (sections.length === 0) {
		const disk = await readSnapshot(T);
		if (disk) {
			disk.meta.stale = true;
			disk.meta.source = "offline-file";
			mem.set(T, disk);
			return disk;
		}
		throw Object.assign(
			new Error(`No sections for term ${T} after term filter`),
			{ code: "E_FETCH" },
		);
	}
	// Duplicate canonical IDs (e.g. half-semester rows collapsing onto one ID)
	// are detected and surfaced, never silently overwritten.
	const seen = new Set<string>();
	const deduped: Section[] = [];
	let duplicateIds = 0;
	for (const s of sections) {
		if (seen.has(s.id)) {
			duplicateIds++;
			continue;
		}
		seen.add(s.id);
		deduped.push(s);
	}
	// Acceptance policy: a mostly-invalid payload or a suspicious count drop
	// against last-good must not replace a complete catalog with a fragment
	// (a schema drift killing 2,000 of 2,188 rows used to pass here).
	const prevDisk = await readSnapshot(T);
	if (prevDisk) {
		const total = raw.length + quarantined;
		const badRatio = total > 0 ? quarantined / total : 0;
		const droppedBelowHalf =
			deduped.length < Math.ceil(prevDisk.sections.length / 2);
		if ((quarantined >= 10 && badRatio > 0.05) || droppedBelowHalf) {
			prevDisk.meta.stale = true;
			prevDisk.meta.source = "offline-file";
			mem.set(T, prevDisk);
			throw Object.assign(
				new Error(
					`Refusing snapshot for ${T}: ${quarantined} quarantined row(s), count ${prevDisk.sections.length} → ${deduped.length}. Keeping last-good snapshot.`,
				),
				{ code: "E_FETCH" },
			);
		}
	}
	// Serialize once: the hash MUST match the exact bytes on disk.
	const dataText = JSON.stringify(deduped);
	const meta: CacheMeta = {
		term: T,
		fetched_at: nowISO(),
		etag,
		hash: sha1(dataText),
		count: deduped.length,
		source_url: `${apiBase()}/sections/${T}`,
		ttl_kind: "seats:60s/schedules:30min",
		stale: false,
		source: "live",
		quarantined,
		duplicate_ids: duplicateIds,
	};
	await mkdir(f.dir, { recursive: true });
	// Data-first, meta-second: readers either see old-old (valid) or
	// new-new (valid); a crash between leaves new-data + old-meta, which
	// fails the hash check and self-heals via refetch.
	await atomicWrite(f.data, dataText);
	await atomicWrite(f.meta, JSON.stringify(meta, null, 1));
	const entry = { sections: deduped, meta };
	mem.set(T, entry);
	await clearNegative(T);
	// A successful refresh of the current term refreshes its timestamp.
	try {
		if (currentTermMem?.value === T) {
			await writeCurrentTermFile(T);
		} else {
			const cur = await readCurrentTermFile();
			if (cur?.value === T) await writeCurrentTermFile(T);
		}
	} catch {
		// best-effort only
	}
	return entry;
}

/** Write a snapshot directly (tests, seeding, proxy prewarm). */
export async function writeSnapshot(
	term: string,
	sections: Section[],
	extra: Partial<CacheMeta> = {},
): Promise<CacheMeta> {
	const T = term.toUpperCase();
	const f = files(T);
	const dataText = JSON.stringify(sections);
	// hash/count are always recomputed from the exact bytes written.
	const { hash: _ignoredHash, count: _ignoredCount, ...safeExtra } = extra;
	const meta: CacheMeta = {
		term: T,
		fetched_at: nowISO(),
		etag: null,
		source_url: safeExtra.source_url ?? "seed",
		ttl_kind: "seed",
		stale: false,
		source: "live",
		quarantined: 0,
		duplicate_ids: 0,
		...safeExtra,
		hash: sha1(dataText),
		count: sections.length,
	};
	await mkdir(f.dir, { recursive: true });
	await atomicWrite(f.data, dataText);
	await atomicWrite(f.meta, JSON.stringify(meta, null, 1));
	mem.set(T, { sections, meta });
	return meta;
}

/** Disk-persisted current term: {value, at}. Best-effort; never throws. */
export async function readCurrentTermFile(): Promise<{
	value: string;
	at: number;
} | null> {
	try {
		const raw = await readFile(currentTermFile(), "utf8");
		const parsed = JSON.parse(raw) as { value: unknown; at: unknown };
		if (
			typeof parsed?.value !== "string" ||
			!/^(FA|SP|SU)\d{4}$/.test(parsed.value) ||
			typeof parsed?.at !== "number" ||
			!Number.isFinite(parsed.at)
		) {
			return null;
		}
		return { value: parsed.value, at: parsed.at };
	} catch {
		return null;
	}
}

export async function writeCurrentTermFile(
	value: string,
): Promise<{ value: string; at: number }> {
	const payload = { value, at: Date.now() };
	try {
		await mkdir(cacheDir(), { recursive: true });
		await atomicWrite(currentTermFile(), JSON.stringify(payload));
	} catch {
		// best-effort only
	}
	setCurrentTermMem(payload.value, payload.at);
	return payload;
}

/** Disk-only meta read for one term: never fetches, never touches network. */
export async function peekTermMeta(term: string): Promise<CacheMeta | null> {
	try {
		const raw = await readFile(files(term.toUpperCase()).meta, "utf8");
		const m = cacheMetaSchema.safeParse(JSON.parse(raw));
		return m.success ? m.data : null;
	} catch {
		return null;
	}
}

function memHistorySet(
	T: string,
	payload: { entries: RawHistoryEntry[]; fetched_at: string },
): void {
	// LRU-ish cap: refresh insertion order, evict oldest beyond cap.
	memHistory.delete(T);
	memHistory.set(T, payload);
	while (memHistory.size > HISTORY_MEM_CAP) {
		const oldest = memHistory.keys().next();
		if (oldest.done) break;
		memHistory.delete(oldest.value);
	}
}

export async function loadHistory(
	term: string,
	opts: { fetchFn?: typeof fetch } = {},
): Promise<{ entries: RawHistoryEntry[]; fetched_at: string; stale: boolean }> {
	const T = term.toUpperCase();
	const cached = memHistory.get(T);
	if (cached && !historyIsStale(cached.fetched_at)) {
		// Refresh LRU position.
		memHistory.delete(T);
		memHistory.set(T, cached);
		return { ...cached, stale: false };
	}
	const inflight = inflightHistory.get(T);
	if (inflight) return inflight;
	const p = loadHistoryInner(T, opts, cached ?? null)
		.then((entry) => {
			inflightHistory.delete(T);
			return entry;
		})
		.catch((err: unknown) => {
			inflightHistory.delete(T);
			throw err;
		});
	inflightHistory.set(T, p);
	return p;
}

async function loadHistoryInner(
	T: string,
	opts: { fetchFn?: typeof fetch },
	staleMem: { entries: RawHistoryEntry[]; fetched_at: string } | null,
): Promise<{ entries: RawHistoryEntry[]; fetched_at: string; stale: boolean }> {
	const f = files(T);
	let staleDisk: {
		entries: RawHistoryEntry[];
		fetched_at: string;
	} | null = null;
	try {
		const raw = await readFile(f.history, "utf8");
		const parsed = JSON.parse(raw) as {
			entries: unknown;
			fetched_at: unknown;
		};
		const entries = rawHistorySchema.safeParse(parsed?.entries);
		if (
			entries.success &&
			typeof parsed?.fetched_at === "string" &&
			!historyIsStale(parsed.fetched_at)
		) {
			const payload = { entries: entries.data, fetched_at: parsed.fetched_at };
			memHistorySet(T, payload);
			return { ...payload, stale: false };
		}
		if (entries.success && typeof parsed?.fetched_at === "string") {
			staleDisk = { entries: entries.data, fetched_at: parsed.fetched_at };
		}
	} catch {
		// fetch below
	}
	try {
		const res = await fetchOfferingHistory(T, {}, opts.fetchFn);
		const entries = rawHistorySchema.parse(res.data);
		const payload = { entries, fetched_at: nowISO() };
		await mkdir(f.dir, { recursive: true });
		await atomicWrite(f.history, JSON.stringify(payload));
		memHistorySet(T, payload);
		return { ...payload, stale: false };
	} catch (err) {
		// Network failure: serve stale (mem first, then disk) rather than fail.
		if (staleMem) {
			memHistorySet(T, staleMem);
			return { ...staleMem, stale: true };
		}
		if (staleDisk) {
			memHistorySet(T, staleDisk);
			return { ...staleDisk, stale: true };
		}
		// A 404 with nothing to serve means the term isn't published upstream —
		// surface the same code as loadTerm so callers fall back uniformly.
		if ((err as { code?: string }).code === "E_NOT_FOUND_UPSTREAM") {
			throw termNotFound(T);
		}
		throw err;
	}
}
