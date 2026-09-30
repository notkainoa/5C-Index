import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearMemoryCache,
	loadTerm,
	refreshTerm,
	writeSnapshot,
} from "../src/cache.js";
import { checkSchedule } from "../src/conflicts.js";
import { fetchJson } from "../src/hyperschedule.js";
import {
	checkScheduleByIds,
	clearSearchCache,
	clearTermCache,
	defaultTerm,
	getClasses,
	getCourseHistory,
	listTerms,
	searchClasses,
} from "../src/index.js";
import { normalizeSection } from "../src/normalize.js";
import { rawSectionsSchema } from "../src/schema.js";
import type { Section } from "../src/schema.js";
import fixtureRaw from "./fixture-raw.json";

/**
 * Deterministic contract tests for the P1 fixes in plan.md: every input
 * resolves independently, terms never substitute silently, registrar status
 * decides availability, time windows are whole-schedule, search never hides
 * filtered matches, checks carry completeness, history tells the truth.
 * All fetch is mocked; no test needs the network.
 */

const TERM = "FA2026";
const raw = rawSectionsSchema.parse(fixtureRaw);
const sections = raw.map(normalizeSection);

/** Synthetic section from the fixture base. */
function mk(
	over: Partial<Section> & { meetings?: Section["meetings"] },
): Section {
	return { ...sections[0], ...over };
}

function mtg(
	days: string[],
	startMin: number,
	endMin: number,
): Section["meetings"][number] {
	const mm = (m: number) =>
		`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
	const m12 = (m: number) => {
		const h24 = Math.floor(m / 60);
		const sfx = h24 >= 12 ? "PM" : "AM";
		const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
		return `${h12}:${String(m % 60).padStart(2, "0")} ${sfx}`;
	};
	return {
		days: days as Section["meetings"][number]["days"],
		startMin,
		endMin,
		startStr: mm(startMin),
		endStr: mm(endMin),
		start12: m12(startMin),
		end12: m12(endMin),
		locations: [],
	};
}

// ---------- mock fetch ----------

interface Route {
	status: number;
	body?: unknown;
	throw?: boolean;
}

function mockFetch(
	handler: (url: string, init?: RequestInit) => Route,
	counter?: { n: number },
): typeof fetch {
	return (async (url: unknown, init?: unknown) => {
		if (counter) counter.n++;
		const r = handler(String(url), (init ?? {}) as RequestInit);
		if (r.throw) throw new Error("net down");
		const headers = new Map<string, string>();
		return {
			status: r.status,
			ok: r.status >= 200 && r.status < 300,
			headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
			json: async () => r.body,
		} as unknown as Response;
	}) as typeof fetch;
}

const historyEntries = [
	{
		code: {
			department: "CSCI",
			courseNumber: 5,
			suffix: "",
			affiliation: "HM",
		},
		terms: [
			{ year: 2026, term: "FA" },
			{ year: 2026, term: "SP" },
		],
	},
	{
		code: {
			department: "ECON",
			courseNumber: 50,
			suffix: "",
			affiliation: "PO",
		},
		terms: [{ year: 2026, term: "FA" }],
	},
	{
		code: {
			department: "ECON",
			courseNumber: 50,
			suffix: "",
			affiliation: "SC",
		},
		terms: [{ year: 2026, term: "FA" }],
	},
];

function termRoutes(extra?: (url: string) => Route | null): {
	fetchFn: typeof fetch;
	calls: () => number;
} {
	const counter = { n: 0 };
	const fetchFn = mockFetch((url) => {
		const e = extra?.(url);
		if (e) return e;
		if (url.endsWith("/term/all")) {
			return {
				status: 200,
				body: [
					{ year: 2026, term: "FA" },
					{ year: 2026, term: "SP" },
					{ year: 2025, term: "SP" },
				],
			};
		}
		if (url.endsWith("/term/current")) {
			return { status: 200, body: { year: 2026, term: "FA" } };
		}
		if (url.endsWith(`/sections/${TERM}`)) {
			return { status: 200, body: raw, etag: undefined };
		}
		if (url.includes("/offering-history/")) {
			return { status: 200, body: historyEntries };
		}
		return { status: 404 };
	}, counter);
	return { fetchFn, calls: () => counter.n };
}

// ---------- tmp data dir ----------

let dir = "";
let prevDataDir: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "5c-contracts-"));
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

// ---------- findings 1+2: per-input ID resolution ----------

describe("ID resolution", () => {
	beforeEach(async () => {
		await writeSnapshot(TERM, sections);
	});

	it("a garbage input is reported, never swallowed (F1)", async () => {
		const { result } = await getClasses(
			["CSCI 005 HM-01 FA2026", "totally invalid input"],
			{ term: TERM },
		);
		expect(result.classes.map((c) => c.id)).toEqual(["CSCI 005 HM-01 FA2026"]);
		expect(result.not_found).toEqual(["totally invalid input"]);
		expect(result.ambiguous).toEqual([]);
	});

	it("schedule checks reject unresolved inputs instead of auditing a subset (F1)", async () => {
		await expect(
			checkScheduleByIds(["CSCI 005 HM-01 FA2026", "totally invalid input"], {
				term: TERM,
			}),
		).rejects.toMatchObject({
			code: "E_NOT_FOUND",
			not_found: ["totally invalid input"],
		});
	});

	it("a wrong section number is a miss, never a silent sibling pick (F2)", async () => {
		const { result } = await getClasses(["CSCI 050 PO-99 FA2026"], {
			term: TERM,
		});
		expect(result.classes).toEqual([]);
		expect(result.not_found).toEqual(["CSCI 050 PO-99 FA2026"]);
		expect(result.suggestions[0]?.ids).toContain("CSCI 050 PO-01 FA2026");
	});

	it("ambiguous loose codes return candidates, not a first pick (F2)", async () => {
		const { result } = await getClasses(["CSCI 050 PO"], { term: TERM });
		expect(result.classes).toEqual([]);
		expect(result.ambiguous).toEqual([
			{
				input: "CSCI 050 PO",
				section_ids: ["CSCI 050 PO-01 FA2026", "CSCI 050 PO-02 FA2026"],
			},
		]);
	});

	it("unique loose codes still resolve (F2)", async () => {
		const { result } = await getClasses(["csci 5 hm"], { term: TERM });
		expect(result.classes.map((c) => c.id)).toEqual(["CSCI 005 HM-01 FA2026"]);
	});

	it("batches over the cap are usage errors, never silent truncation (F2)", async () => {
		const ids = Array.from(
			{ length: 21 },
			(_, i) => `CSCI 005 HM-01 FA2026 #${i}`,
		);
		await expect(getClasses(ids, { term: TERM })).rejects.toMatchObject({
			code: "E_USAGE",
		});
		await expect(
			checkScheduleByIds(ids.slice(0, 21), { term: TERM }),
		).rejects.toMatchObject({ code: "E_USAGE" });
	});

	it("per-term provenance survives multi-term batches (F2)", async () => {
		const sp = mk({ term: "SP2026", id: "CSCI 005 HM-01 SP2026" });
		await writeSnapshot("SP2026", [sp]);
		const { result, terms } = await getClasses(
			["CSCI 005 HM-01 FA2026", "CSCI 005 HM-01 SP2026"],
			{},
		);
		expect(result.classes).toHaveLength(2);
		expect(terms.map((t) => t.term)).toEqual(["FA2026", "SP2026"]);
		for (const t of terms) expect(t.fetched_at.length).toBeGreaterThan(0);
	});

	it("checks are term-scoped: mixed-term IDs are usage errors (F18)", async () => {
		const sp = mk({ term: "SP2026", id: "CSCI 005 HM-01 SP2026" });
		await writeSnapshot("SP2026", [sp]);
		await expect(
			checkScheduleByIds(
				["CSCI 005 HM-01 FA2026", "CSCI 005 HM-01 SP2026"],
				{},
			),
		).rejects.toMatchObject({ code: "E_USAGE" });
	});
});

// ---------- finding 3: term fallback is opt-in ----------

describe("term handling", () => {
	it("unpublished terms reject with available terms, no substitution (F3)", async () => {
		const { fetchFn } = termRoutes();
		await expect(
			searchClasses("", { term: "FA2099", fetchFn }),
		).rejects.toMatchObject({
			code: "E_TERM_NOT_FOUND",
			available: expect.arrayContaining([TERM]),
		});
	});

	it("explicit opt-in serves the newest term with a warning (F3)", async () => {
		const { fetchFn } = termRoutes();
		const { result, fallback, warning } = await searchClasses("", {
			term: "FA2099",
			fetchFn,
			allowTermFallback: true,
			limit: 3,
		});
		expect(result.term).toBe(TERM);
		expect(fallback).toEqual({ requested: "FA2099", served: TERM });
		expect(warning).toContain("not published");
	});

	it("terms order by calendar recency, including on lookup failure (F14)", async () => {
		const { fetchFn } = termRoutes();
		const { available, current } = await listTerms({ fetchFn });
		expect(current).toBe(TERM);
		expect(available.map((t) => t.code)).toEqual([
			"FA2026",
			"SP2026",
			"SP2025",
		]);
		const failing = termRoutes((url) =>
			url.endsWith("/term/current") ? { status: 404 } : null,
		);
		const { current: fallbackCurrent } = await listTerms({
			fetchFn: failing.fetchFn,
		});
		// Lexicographic sort would pick SP2025 here.
		expect(fallbackCurrent).toBe(TERM);
	});

	it("with no network and no cache, the current term is an honest error (F14)", async () => {
		const fetchFn = mockFetch(() => ({ status: 404 }));
		await expect(defaultTerm(fetchFn)).rejects.toMatchObject({
			code: "E_NO_CURRENT_TERM",
		});
	});
});

// ---------- findings 4+5: availability and time windows ----------

describe("availability + time windows", () => {
	const closedWithCapacity = mk({
		id: "TEST 001 PO-01 FA2026",
		dept: "TEST",
		number: 1,
		school: "PO",
		code: "TEST 001",
		status: "C" as const,
		statusLabel: "Closed",
		seats: { filled: 5, total: 10, available: 5, permCount: 0 },
	});
	const openEnrolled = mk({
		id: "TEST 002 PO-01 FA2026",
		dept: "TEST",
		number: 2,
		school: "PO",
		code: "TEST 002",
		status: "O" as const,
		seats: { filled: 12, total: 10, available: 0, permCount: 0 },
	});

	beforeEach(async () => {
		await writeSnapshot(TERM, [closedWithCapacity, openEnrolled, ...sections]);
	});

	it("closed sections with spare capacity never pass open-only (F4)", async () => {
		const { result } = await searchClasses("", {
			term: TERM,
			open: true,
			schools: ["PO"],
			limit: 50,
		});
		const ids = result.hits.map((h) => h.id);
		expect(ids).not.toContain("TEST 001 PO-01 FA2026");
		expect(ids).toContain("TEST 002 PO-01 FA2026"); // registrable status passes
	});

	it("seat problems describe status truthfully (F4)", () => {
		const r = checkSchedule([closedWithCapacity, openEnrolled]);
		expect(r.seat_problems).toHaveLength(2);
		expect(r.seat_problems[0].reason).toContain(
			"Closed by registrar (status C",
		);
		expect(r.seat_problems[1].reason).toContain(
			"No remaining capacity (status O",
		);
		expect(r.ok).toBe(false);
	});

	it("inverted time windows are usage errors (F5)", async () => {
		const counter = { n: 0 };
		const fetchFn = mockFetch(() => ({ status: 404 }), counter);
		await expect(
			searchClasses("", {
				term: TERM,
				after: "13:00",
				before: "11:00",
				fetchFn,
			}),
		).rejects.toMatchObject({ code: "E_BAD_FILTER" });
	});

	it("split-block sections cannot satisfy a window with different meetings (F5)", async () => {
		const split = mk({
			id: "TEST 003 PO-01 FA2026",
			dept: "TEST",
			number: 3,
			school: "PO",
			code: "TEST 003",
			meetings: [mtg(["M"], 540, 600), mtg(["M"], 840, 900)],
		});
		await writeSnapshot(TERM, [split]);
		const { result } = await searchClasses("", {
			term: TERM,
			after: "13:00",
			before: "16:00",
		});
		expect(result.total).toBe(0);
	});
});

// ---------- findings 6+7+15: search recall ----------

describe("search recall", () => {
	const poTitle = mk({
		id: "GEN 001 PO-01 FA2026",
		dept: "GEN",
		number: 1,
		school: "PO",
		code: "GEN 001",
		title: "Genetics",
		description: "",
	});
	const hmDesc = mk({
		id: "GEN 002 HM-01 FA2026",
		dept: "GEN",
		number: 2,
		school: "HM",
		code: "GEN 002",
		title: "Cell Biology",
		description: "Genetics and heredity in depth.",
	});

	beforeEach(async () => {
		await writeSnapshot(TERM, [poTitle, hmDesc]);
	});

	it("a title match on a filtered-out campus never hides valid matches (F6)", async () => {
		const { result } = await searchClasses("genetics", {
			term: TERM,
			schools: ["HM"],
		});
		expect(result.total).toBe(1);
		expect(result.hits[0].id).toBe("GEN 002 HM-01 FA2026");
	});

	it("code-shaped queries stay strict (F6)", async () => {
		const { result } = await searchClasses("QQQ 000", { term: TERM });
		expect(result.total).toBe(0);
	});

	it("exact codes honor school filters (F6/F15)", async () => {
		const { result } = await searchClasses("GEN 001", {
			term: TERM,
			schools: ["HM"],
		});
		expect(result.total).toBe(0);
	});

	it("unknown exclusion anchors are errors, not no-ops (F7)", async () => {
		await expect(
			searchClasses("", {
				term: TERM,
				excludeConflictsWith: ["MISSING 000 XX-00 FA2026"],
			}),
		).rejects.toMatchObject({ code: "E_NOT_FOUND" });
	});

	it("valid anchors drop the anchor and its overlaps (F7)", async () => {
		const base = await searchClasses("", { term: TERM, limit: 50 });
		const excl = await searchClasses("", {
			term: TERM,
			limit: 50,
			excludeConflictsWith: ["GEN 001 PO-01 FA2026"],
		});
		expect(excl.result.total).toBeLessThan(base.result.total);
		expect(excl.result.hits.map((h) => h.id)).not.toContain(
			"GEN 001 PO-01 FA2026",
		);
	});

	it("--code 'CSCI 05' matches the 050 family, not 005 (F15)", async () => {
		await writeSnapshot(TERM, sections);
		const fam = await searchClasses("", { term: TERM, code: "CSCI 05" });
		expect(fam.result.hits.length).toBeGreaterThan(0);
		for (const h of fam.result.hits) expect(h.code).toMatch(/^CSCI 05\d/);
		const exact = await searchClasses("", { term: TERM, code: "CSCI 5" });
		expect(exact.result.hits.map((h) => h.code)).toEqual(["CSCI 005"]);
	});
});

// ---------- finding 8: check completeness ----------

describe("check completeness", () => {
	it("TBA sections make the audit incomplete, not silently OK (F8)", () => {
		const tba = mk({ id: "TBA 001 PO-01 FA2026", meetings: [] });
		const r = checkSchedule([sections[0], tba]);
		expect(r.skipped_tba).toEqual(["TBA 001 PO-01 FA2026"]);
		expect(r.complete).toBe(false);
		expect(r.ok).toBe(true); // no conflicts found...
		expect(r.warnings.join(" ")).toContain("Time TBA");
	});

	it("potential_error data makes the audit incomplete and warns (F8)", () => {
		const flagged = mk({
			id: "BAD 001 PO-01 FA2026",
			dept: "BAD",
			code: "BAD 001",
			potentialError: true,
		});
		const r = checkSchedule([sections[0], flagged]);
		expect(r.complete).toBe(false);
		expect(r.warnings.join(" ")).toContain("potential_error");
	});

	it("clean schedules are complete (F8)", () => {
		const r = checkSchedule([
			sections.find((s) => s.id === "CSCI 005 HM-01 FA2026")!,
			sections.find((s) => s.id === "MATH 019 HM-01 FA2026")!,
		]);
		expect(r.complete).toBe(true);
		expect(r.skipped_tba).toEqual([]);
	});

	it("weekly grid covers weekends (F20)", () => {
		const sat = mk({
			id: "WKND 001 PO-01 FA2026",
			dept: "WKND",
			code: "WKND 001",
			meetings: [mtg(["S"], 540, 600)],
		});
		const r = checkSchedule([sat]);
		expect(r.weekly_grid).toContain("S: 09:00-10:00");
		expect(r.warnings.join(" ")).not.toContain("Heavy load");
	});
});

// ---------- findings 9+10+11: credits + history ----------

describe("history", () => {
	beforeEach(async () => {
		await writeSnapshot(TERM, sections);
	});

	it("history for a course at another campus says so instead of substituting (F10)", async () => {
		const { fetchFn } = termRoutes();
		const h = await getCourseHistory("CSCI 005 PO", { term: TERM, fetchFn });
		expect(h.offerings).toEqual([]);
		expect(h.rotation_note).toContain("HM");
	});

	it("history matches full identity and reports observed windows (F10/F11)", async () => {
		const { fetchFn } = termRoutes();
		const h = await getCourseHistory("CSCI 005", { term: TERM, fetchFn });
		expect(h.code).toBe("CSCI 005");
		expect(h.offerings.map((o) => o.term)).toEqual(["FA2026", "SP2026"]);
		expect(h.offerings.every((o) => o.campus === "HM")).toBe(true);
		expect(h.verdict).toContain("window");
		expect(h.rotation_note).not.toContain("most often by");
		expect(h.enrichment?.term).toBe(TERM);
	});

	it("multi-campus codes defer to a per-school verdict (F10)", async () => {
		const { fetchFn } = termRoutes();
		const h = await getCourseHistory("ECON 050", { term: TERM, fetchFn });
		expect(h.verdict).toContain("History exists at PO, SC");
	});

	it("department-only queries ask for a course number (F10)", async () => {
		const { fetchFn } = termRoutes();
		const h = await getCourseHistory("CSCI", { term: TERM, fetchFn });
		expect(h.offerings).toEqual([]);
		expect(h.rotation_note).toContain("course number");
	});

	it("credit totals carry no cross-college load advice (F9)", async () => {
		const hm3 = sections.find((s) => s.id === "MATH 019 HM-01 FA2026")!; // 4 credits
		const r = checkSchedule([hm3]);
		expect(r.warnings.join(" ")).not.toContain("Heavy load");
		expect(r.warnings.join(" ")).not.toContain("Light load");
	});
});

// ---------- findings 12+13+17+16: transport + ingest + validation ----------

describe("transport + ingest", () => {
	it("a stalled response body times out instead of hanging (F12)", async () => {
		const stalled = (async (_url: unknown, init?: unknown) => {
			const signal = (init as RequestInit).signal as AbortSignal;
			return {
				status: 200,
				ok: true,
				headers: { get: () => null },
				json: () =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () =>
							reject(
								Object.assign(new Error("The operation was aborted."), {
									name: "AbortError",
								}),
							),
						);
					}),
			} as unknown as Response;
		}) as typeof fetch;
		await expect(
			fetchJson(
				"https://example.test/x",
				(u) => u,
				{
					timeoutMs: 60,
					retries: 0,
				},
				stalled,
			),
		).rejects.toThrow("Timeout fetching");
	});

	it("a mostly-invalid ingest is refused and last-good survives (F13)", async () => {
		await writeSnapshot(TERM, sections);
		const badPayload = [...(raw as unknown[])];
		for (let i = 0; i < 15; i++) badPayload.push({ bogus: true });
		const fetchFn = mockFetch(() => ({ status: 200, body: badPayload }));
		await expect(refreshTerm(TERM, { fetchFn })).rejects.toMatchObject({
			code: "E_FETCH",
		});
		const { sections: after } = await loadTerm(TERM, {
			allowStale: false,
			fetchFn,
		});
		expect(after.length).toBe(sections.length); // last-good intact
	});

	it("duplicate canonical IDs are surfaced, not silently overwritten (F27)", async () => {
		const dupPayload = [...(raw as unknown[]), (raw as unknown[])[0]];
		const fetchFn = mockFetch(() => ({ status: 200, body: dupPayload }));
		const { sections: got, meta } = await refreshTerm(TERM, { fetchFn });
		expect(got.length).toBe(sections.length); // deduped
		expect(meta.duplicate_ids).toBe(1);
		const metaRaw = JSON.parse(
			await readFile(join(dir, `${TERM}.meta.json`), "utf8"),
		) as { duplicate_ids: number };
		expect(metaRaw.duplicate_ids).toBe(1);
	});

	it("bad filters reject before any fetch (F16)", async () => {
		const counter = { n: 0 };
		const fetchFn = mockFetch(() => ({ status: 404 }), counter);
		await expect(
			searchClasses("", { term: TERM, days: "123", fetchFn }),
		).rejects.toMatchObject({ code: "E_BAD_FILTER" });
		await expect(
			searchClasses("", { term: "FA123", fetchFn }),
		).rejects.toMatchObject({ code: "E_BAD_TERM" });
		await expect(
			searchClasses("", { term: TERM, depts: ["C-S-I"], fetchFn }),
		).rejects.toMatchObject({ code: "E_BAD_FILTER" });
		await expect(
			searchClasses("", { term: TERM, code: "???", fetchFn }),
		).rejects.toMatchObject({ code: "E_BAD_FILTER" });
		expect(counter.n).toBe(0);
	});

	it("search results carry snapshot identity and hit meeting blocks (F21/F22)", async () => {
		await writeSnapshot(TERM, sections);
		const { result } = await searchClasses("", { term: TERM, limit: 3 });
		expect(result.snapshot_id).toHaveLength(12);
		for (const h of result.hits) {
			expect(typeof h.credits).toBe("number");
			expect(typeof h.potential_error).toBe("boolean");
			expect(Array.isArray(h.meetings)).toBe(true);
		}
	});
});
