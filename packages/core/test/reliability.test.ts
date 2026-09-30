import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearMemoryCache,
	loadHistory,
	loadTerm,
	quarantineRawSections,
	readCurrentTermFile,
	refreshTerm,
	writeSnapshot,
} from "../src/cache.js";
import {
	clearSearchCache,
	clearTermCache,
	defaultTerm,
	getCourseHistory,
	searchClasses,
} from "../src/index.js";
import { normalizeSection } from "../src/normalize.js";
import { rawSectionsSchema } from "../src/schema.js";
import { MiniSearchProvider } from "../src/search.js";
import fixtureRaw from "./fixture-raw.json";

const TERM = "FA2026";
const raw = rawSectionsSchema.parse(fixtureRaw);
const sections = raw.map(normalizeSection);

// ---------- mock fetch ----------

interface Route {
	status: number;
	body?: unknown;
	etag?: string;
}

function mockFetch(
	handler: (url: string, init?: RequestInit) => Route,
	counter?: { n: number },
): typeof fetch {
	return (async (url: unknown, init?: unknown) => {
		if (counter) counter.n++;
		const r = handler(String(url), (init ?? {}) as RequestInit);
		const headers = new Map<string, string>();
		if (r.etag) headers.set("etag", r.etag);
		return {
			status: r.status,
			ok: r.status >= 200 && r.status < 300,
			headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
			json: async () => r.body,
		} as unknown as Response;
	}) as typeof fetch;
}

const sectionsRoute: Route = { status: 200, body: raw, etag: '"v1"' };

function termRoutes(extra?: (url: string, init?: RequestInit) => Route | null) {
	return mockFetch((url, init) => {
		if (extra) {
			const r = extra(url, init);
			if (r) return r;
		}
		if (url.endsWith("/term/all")) {
			return {
				status: 200,
				body: [
					{ year: 2026, term: "FA" },
					{ year: 2026, term: "SP" },
				],
			};
		}
		if (url.endsWith("/term/current")) {
			return { status: 200, body: { year: 2026, term: "FA" } };
		}
		if (url.endsWith(`/sections/${TERM}`)) return sectionsRoute;
		if (url.includes("/sections/")) return { status: 404 };
		if (url.includes("/offering-history/")) {
			return {
				status: 200,
				body: [
					{
						code: {
							department: "CSCI",
							courseNumber: 5,
							suffix: "",
							affiliation: "HM",
						},
						terms: [{ year: 2026, term: "FA" }],
					},
				],
			};
		}
		return { status: 404 };
	});
}

// ---------- tmp data dir ----------

let dir = "";
let prevDataDir: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "5c-test-"));
	prevDataDir = process.env.FIVE_C_DATA_DIR;
	process.env.FIVE_C_DATA_DIR = dir;
	clearMemoryCache();
	clearTermCache();
	clearSearchCache();
});

afterEach(() => {
	if (prevDataDir === undefined) {
		Reflect.deleteProperty(process.env, "FIVE_C_DATA_DIR");
	} else {
		process.env.FIVE_C_DATA_DIR = prevDataDir;
	}
	clearMemoryCache();
	clearTermCache();
	clearSearchCache();
});

function dataPath(): string {
	return join(dir, `${TERM}.json`);
}
function metaPath(): string {
	return join(dir, `${TERM}.meta.json`);
}

// ---------- F1/F2/F3: poison reads heal via full fetch ----------

describe("snapshot validation on load", () => {
	it("empty-array cache is discarded and refetched (F1)", async () => {
		const counter = { n: 0 };
		await writeSnapshot(TERM, sections);
		await writeFile(dataPath(), "[]"); // poison, keep valid meta
		clearMemoryCache();
		const fetchFn = mockFetch(() => sectionsRoute, counter);
		const { sections: got, meta } = await loadTerm(TERM, { fetchFn });
		expect(counter.n).toBeGreaterThan(0);
		expect(got.length).toBe(sections.length);
		expect(meta.stale).toBe(false);
	});

	it("wrong-shape ({}) cache never crashes and heals (F3)", async () => {
		await writeSnapshot(TERM, sections);
		await writeFile(dataPath(), "{}");
		clearMemoryCache();
		const fetchFn = mockFetch(() => sectionsRoute);
		const { sections: got } = await loadTerm(TERM, { fetchFn });
		expect(got.length).toBe(sections.length);
	});

	it("truncated invalid-JSON bytes heal instead of exit 1 (F2)", async () => {
		await writeSnapshot(TERM, sections);
		await writeFile(dataPath(), '{"truncated": tru');
		clearMemoryCache();
		const fetchFn = mockFetch(() => sectionsRoute);
		const { sections: got } = await loadTerm(TERM, { fetchFn });
		expect(got.length).toBe(sections.length);
	});

	it("count-vs-meta mismatch forces refetch", async () => {
		const counter = { n: 0 };
		// writeSnapshot always recomputes count from bytes (by design), so
		// seed the drift at the file level: 3 sections, meta claims 2188.
		await writeSnapshot(TERM, sections.slice(0, 3));
		const parsed = JSON.parse(await readFile(metaPath(), "utf8")) as {
			count: number;
		};
		parsed.count = 2188;
		await writeFile(metaPath(), JSON.stringify(parsed));
		clearMemoryCache();
		const fetchFn = mockFetch(() => sectionsRoute, counter);
		const { sections: got } = await loadTerm(TERM, { fetchFn });
		expect(counter.n).toBeGreaterThan(0);
		expect(got.length).toBe(sections.length);
	});

	it("304 with corrupt bytes retries once with a full fetch (F1/F2)", async () => {
		await writeSnapshot(TERM, sections, { etag: '"abc"' });
		await writeFile(dataPath(), "not json at all{{{");
		clearMemoryCache();
		let saw304 = false;
		let sawFull = false;
		const fetchFn = mockFetch((_url, init) => {
			const inm = (init?.headers as Record<string, string> | undefined)?.[
				"If-None-Match"
			];
			if (inm === '"abc"') {
				saw304 = true;
				return { status: 304 };
			}
			sawFull = true;
			return sectionsRoute;
		});
		const { sections: got, meta } = await refreshTerm(TERM, { fetchFn });
		expect(saw304).toBe(true);
		expect(sawFull).toBe(true);
		expect(got.length).toBe(sections.length);
		expect(meta.stale).toBe(false);
	});

	it("offline fallback with corrupt disk throws the network error, not SyntaxError", async () => {
		await writeSnapshot(TERM, sections);
		await writeFile(dataPath(), "{{{corrupt");
		clearMemoryCache();
		const fetchFn = mockFetch(() => {
			throw new Error("boom-network");
		});
		await expect(loadTerm(TERM, { fetchFn })).rejects.toThrow("boom-network");
	});
});

// ---------- F8: future-dated fetched_at ----------

describe("staleness", () => {
	it("future-dated fetched_at is stale and refreshes (F8)", async () => {
		const counter = { n: 0 };
		const future = new Date(Date.now() + 60 * 60_000).toISOString();
		await writeSnapshot(TERM, sections, { fetched_at: future });
		clearMemoryCache();
		const fetchFn = mockFetch(() => sectionsRoute, counter);
		const { meta } = await loadTerm(TERM, { fetchFn, allowStale: false });
		expect(counter.n).toBeGreaterThan(0);
		expect(Date.parse(meta.fetched_at)).toBeLessThanOrEqual(Date.now() + 5000);
		expect(meta.stale).toBe(false);
	});
});

// ---------- F4: atomic writes ----------

describe("atomic writes", () => {
	it("no tmp files remain and hash matches bytes", async () => {
		const fetchFn = mockFetch(() => sectionsRoute);
		await refreshTerm(TERM, { fetchFn });
		await writeSnapshot(TERM, sections);
		const names = await readdir(dir);
		expect(names.filter((n) => n.endsWith(".tmp")).length).toBe(0);
		expect(names).toContain(`${TERM}.json`);
		expect(names).toContain(`${TERM}.meta.json`);
		const [dataRaw, metaRaw] = await Promise.all([
			readFile(dataPath(), "utf8"),
			readFile(metaPath(), "utf8"),
		]);
		const meta = JSON.parse(metaRaw) as { hash: string; count: number };
		const { createHash } = await import("node:crypto");
		expect(meta.hash).toBe(createHash("sha1").update(dataRaw).digest("hex"));
		expect(JSON.parse(dataRaw).length).toBe(meta.count);
	});
});

// ---------- F9: persistent negative cache ----------

describe("negative cache", () => {
	it("404 persists to disk, blocks refetch, honors force (F9)", async () => {
		const counter = { n: 0 };
		const fetchFn = mockFetch(() => ({ status: 404 }), counter);
		await expect(refreshTerm(TERM, { fetchFn })).rejects.toMatchObject({
			code: "E_TERM_NOT_FOUND",
		});
		expect(counter.n).toBe(1);
		const negRaw = await readFile(join(dir, `${TERM}.neg.json`), "utf8");
		expect(typeof (JSON.parse(negRaw) as { at: number }).at).toBe("number");
		// Second call: no new fetch.
		await expect(refreshTerm(TERM, { fetchFn })).rejects.toMatchObject({
			code: "E_TERM_NOT_FOUND",
		});
		expect(counter.n).toBe(1);
		// Force bypasses the negative entry.
		await expect(
			refreshTerm(TERM, { fetchFn, force: true }),
		).rejects.toMatchObject({ code: "E_TERM_NOT_FOUND" });
		expect(counter.n).toBe(2);
	});
});

// ---------- F13: single-flight dedup ----------

describe("in-flight dedup", () => {
	it("parallel refreshTerm shares one fetch (F13)", async () => {
		const counter = { n: 0 };
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const fetchFn = mockFetch(() => sectionsRoute, counter);
		const slowFetch = (async (url: unknown, init?: unknown) => {
			await gate;
			return fetchFn(url as string, init as RequestInit);
		}) as typeof fetch;
		const [a, b] = await Promise.all([
			(async () => {
				const p = refreshTerm(TERM, { fetchFn: slowFetch });
				await Promise.resolve();
				release();
				return p;
			})(),
			refreshTerm(TERM, { fetchFn: slowFetch }),
		]);
		expect(a.sections.length).toBe(sections.length);
		expect(b.sections.length).toBe(sections.length);
		expect(counter.n).toBe(1);
	});

	it("parallel loadHistory shares one fetch", async () => {
		const counter = { n: 0 };
		const fetchFn = mockFetch(
			(url) =>
				url.includes("/offering-history/")
					? { status: 200, body: [] }
					: { status: 404 },
			counter,
		);
		const [a, b] = await Promise.all([
			loadHistory(TERM, { fetchFn }),
			loadHistory(TERM, { fetchFn }),
		]);
		expect(a.entries).toEqual([]);
		expect(b.entries).toEqual([]);
		expect(counter.n).toBe(1);
	});
});

// ---------- quarantine ----------

describe("quarantine at ingest", () => {
	it("quarantineRawSections keeps good items and counts rejects", () => {
		const mixed = [...(raw as unknown[]), { bogus: true }, 42];
		const { raw: good, quarantined } = quarantineRawSections(mixed);
		expect(good.length).toBe(raw.length);
		expect(quarantined).toBe(2);
	});

	it("one bad section never fails the whole term", async () => {
		const bad = { bogus: "section" };
		const fetchFn = mockFetch(() => ({
			status: 200,
			body: [...(raw as unknown[]), bad],
		}));
		const { sections: got, meta } = await refreshTerm(TERM, { fetchFn });
		expect(got.length).toBe(sections.length);
		expect(meta.quarantined).toBe(1);
	});
});

// ---------- E_BAD_TERM + fallback ----------

describe("term handling", () => {
	it("unparseable term throws E_BAD_TERM with hint", async () => {
		await expect(searchClasses("", { term: "blarg" })).rejects.toMatchObject({
			code: "E_BAD_TERM",
			hint: expect.stringContaining("FA2026"),
		});
	});

	it("unpublished term rejects with available terms attached (no silent substitution)", async () => {
		const fetchFn = termRoutes();
		await expect(
			searchClasses("", { term: "FA2099", limit: 5, fetchFn }),
		).rejects.toMatchObject({
			code: "E_TERM_NOT_FOUND",
			available: expect.arrayContaining([TERM]),
		});
	});

	it("unpublished term serves the newest only when fallback is explicit opt-in", async () => {
		const fetchFn = termRoutes();
		const { result, fallback, warning } = await searchClasses("", {
			term: "FA2099",
			limit: 5,
			fetchFn,
			allowTermFallback: true,
		});
		expect(result.term).toBe(TERM);
		expect(fallback).toEqual({ requested: "FA2099", served: TERM });
		expect(warning).toContain("not published");
		expect(warning).toContain(TERM);
		expect(result.total).toBeGreaterThan(0);
	});
});

// ---------- provenance: search hits + history ----------

describe("provenance", () => {
	it("CompactHit carries fetched_at + stale", async () => {
		await writeSnapshot(TERM, sections);
		const { result } = await searchClasses("", { term: TERM, limit: 3 });
		expect(result.hits.length).toBeGreaterThan(0);
		for (const h of result.hits) {
			expect(typeof h.fetched_at).toBe("string");
			expect(h.fetched_at.length).toBeGreaterThan(0);
			expect(typeof h.stale).toBe("boolean");
		}
		expect(result.stale).toBe(false);
	});

	it("HistoryResult carries fetched_at/stale/snapshot_term", async () => {
		await writeSnapshot(TERM, sections);
		const fetchFn = termRoutes();
		const h = await getCourseHistory("CSCI 005", { term: TERM, fetchFn });
		expect(h.offerings.length).toBeGreaterThan(0);
		expect(typeof h.fetched_at).toBe("string");
		expect(h.fetched_at.length).toBeGreaterThan(0);
		expect(h.stale).toBe(false);
		expect(h.snapshot_term).toBe(TERM);
	});
});

// ---------- lazy index ----------

describe("lazy MiniSearch build", () => {
	it("pre-pass queries never build the index; full-text does", () => {
		const p = new MiniSearchProvider();
		p.setSections(sections);
		expect(p.indexBuilt).toBe(false);
		const exact = p.query("CSCI 005", {});
		expect(exact[0].match).toContain("exact-code");
		expect(p.indexBuilt).toBe(false);
		const browse = p.query("", {});
		expect(browse.length).toBe(sections.length);
		expect(p.indexBuilt).toBe(false);
		// "computational" lives only in a description: misses every pre-pass,
		// forcing the full-text path (title-phrase would skip the index).
		const text = p.query("computational", {});
		expect(p.indexBuilt).toBe(true);
		expect(text[0].section.id).toBe("CSCI 005 HM-01 FA2026");
	});

	it("lazy path matches eager build results + timing smoke", () => {
		// Scale to ~2200 docs for a meaningful timing signal.
		const big = Array.from({ length: 220 }, (_, i) =>
			sections.map((s, j) => ({
				...s,
				id: `${s.id}#${i}-${j}`,
				title: `${s.title} variant ${i}`,
			})),
		).flat();
		expect(big.length).toBeGreaterThan(2000);
		const lazy = new MiniSearchProvider();
		const t0 = performance.now();
		lazy.setSections(big);
		const setMs = performance.now() - t0;
		expect(lazy.indexBuilt).toBe(false);
		const t1 = performance.now();
		lazy.ensureIndex();
		const buildMs = performance.now() - t1;
		expect(lazy.indexBuilt).toBe(true);
		// ensureIndex is idempotent.
		lazy.ensureIndex();
		const eager = new MiniSearchProvider();
		eager.build(big);
		const q = "computational";
		expect(lazy.query(q, {}).map((h) => h.section.id)).toEqual(
			eager.query(q, {}).map((h) => h.section.id),
		);
		// Timing smoke: byId-only setup must be strictly cheaper than a full
		// MiniSearch build over 2000+ docs (the ~65-90ms/term win).
		expect(setMs).toBeLessThan(buildMs);
	});
});

// ---------- current-term disk persist ----------

describe("current-term persistence", () => {
	it("defaultTerm uses mem → file → network and writes the file", async () => {
		const counter = { n: 0 };
		const fetchFn = mockFetch(
			(url) =>
				url.endsWith("/term/current")
					? { status: 200, body: { year: 2026, term: "FA" } }
					: { status: 404 },
			counter,
		);
		expect(await defaultTerm(fetchFn)).toBe(TERM);
		expect(counter.n).toBe(1);
		const file = await readCurrentTermFile();
		expect(file?.value).toBe(TERM);
		// Second call: mem hit, no network.
		expect(await defaultTerm(fetchFn)).toBe(TERM);
		expect(counter.n).toBe(1);
		// Mem cleared, file fresh: no network.
		clearTermCache();
		expect(await defaultTerm(fetchFn)).toBe(TERM);
		expect(counter.n).toBe(1);
		// Network down + mem cleared: stale file still served over hardcoded default.
		clearTermCache();
		const failing = mockFetch(() => {
			throw new Error("net down");
		});
		expect(await defaultTerm(failing)).toBe(TERM);
	});

	it("refreshTerm success refreshes the current-term timestamp", async () => {
		const old = { value: TERM, at: Date.now() - 4 * 60_000 };
		await writeFile(join(dir, "current-term.json"), JSON.stringify(old));
		const fetchFn = mockFetch(() => sectionsRoute);
		await refreshTerm(TERM, { fetchFn });
		const file = await readCurrentTermFile();
		expect(file?.value).toBe(TERM);
		expect(file!.at).toBeGreaterThan(old.at);
	});
});

// ---------- loadHistory TTL ----------

describe("loadHistory TTL", () => {
	it("refetches after 24h", async () => {
		const counter = { n: 0 };
		const staleAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
		await writeSnapshot(TERM, sections);
		const { writeFile: wf } = await import("node:fs/promises");
		await wf(
			join(dir, `${TERM}.history.json`),
			JSON.stringify({ entries: [], fetched_at: staleAt }),
		);
		const fetchFn = mockFetch(
			(url) =>
				url.includes("/offering-history/")
					? { status: 200, body: [] }
					: sectionsRoute,
			counter,
		);
		const first = await loadHistory(TERM, { fetchFn });
		expect(counter.n).toBe(1);
		expect(first.stale).toBe(false);
		// Second call within TTL: no fetch.
		const second = await loadHistory(TERM, { fetchFn });
		expect(counter.n).toBe(1);
		expect(second.stale).toBe(false);
	});
});
