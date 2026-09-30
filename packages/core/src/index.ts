import {
	CURRENT_TERM_TTL_MS,
	clearCurrentTermMem,
	getCurrentTermMem,
	loadHistory,
	loadTerm,
	peekTermMeta,
	readCurrentTermFile,
	setCurrentTermMem,
	writeCurrentTermFile,
} from "./cache.js";
import { checkSchedule, sectionsOverlap } from "./conflicts.js";
import { FilterError, normalizeFilters } from "./filters.js";
import { courseHistory } from "./history.js";
import { fetchAllTerms, fetchCurrentTerm } from "./hyperschedule.js";
import {
	compareTermRecencyDesc,
	detectSchoolMention,
	normalizeTerm,
	parseCode,
	sectionId,
	termLabel,
} from "./normalize.js";
import type { ParsedCode } from "./normalize.js";
import type { CacheMeta } from "./schema.js";
import type { RawHistoryEntry, Section } from "./schema.js";
import { MiniSearchProvider, paginate } from "./search.js";
import type {
	CheckResult,
	Filters,
	GetResult,
	HistoryResult,
	SearchResult,
	SnapshotMeta,
	TermFallback,
	TermInfo,
	TermProvenance,
} from "./types.js";

/**
 * Public core API. CLI (packages/cli) and MCP (packages/mcp) are thin
 * wrappers over these functions — no duplicated logic.
 *
 * Core contracts (plan.md):
 * - Every input resolves independently. Success on one input never implies
 *   resolution of another; garbage is reported, never swallowed.
 * - An unpublished term is E_TERM_NOT_FOUND (with available terms), never a
 *   silent substitution. Fallback is opt-in per call.
 * - Registrar status decides registrability everywhere; computed capacity
 *   is a reported signal, never an eligibility claim.
 * - Availability of evidence is surfaced: check results carry `complete`,
 *   history verdicts name their observed window.
 */

export interface EngineOptions {
	fetchFn?: typeof fetch;
}

// ---------- in-process search index cache ----------

// MiniSearch index build costs ~60ms for a full term; rebuilding per call is
// pure waste in long-lived processes (MCP server). Keyed by term+content hash.
const providers = new Map<string, MiniSearchProvider>();

function getProvider(
	term: string,
	sections: Section[],
	hash: string,
): MiniSearchProvider {
	const key = `${term}:${hash}`;
	const hit = providers.get(key);
	if (hit) return hit;
	// Bound memory: keep at most 4 terms.
	if (providers.size >= 4) {
		const oldest = providers.keys().next();
		if (!oldest.done) providers.delete(oldest.value);
	}
	const provider = new MiniSearchProvider();
	provider.setSections(sections); // lazy: MiniSearch builds on first full-text need
	providers.set(key, provider);
	return provider;
}

export function clearSearchCache(): void {
	providers.clear();
}

// /term/current is hand-maintained and changes rarely; memoize 5 minutes
// (mem → disk file → network) to avoid a round-trip on every invocation.
export function clearTermCache(): void {
	clearCurrentTermMem();
}

/**
 * Provenance for one served snapshot. Ingest counts travel with every result:
 * a search that hides quarantined rows is a search that lies about coverage.
 */
function snapshotMeta(m: CacheMeta): SnapshotMeta {
	return {
		fetched_at: m.fetched_at,
		stale: m.stale,
		quarantined: m.quarantined ?? 0,
		duplicate_ids: m.duplicate_ids ?? 0,
	};
}

/** Merge provenance across every snapshot a multi-term batch touched. */
function combinedMeta(metas: CacheMeta[]): SnapshotMeta {
	const first = metas[0];
	if (!first) {
		return { fetched_at: "", stale: false, quarantined: 0, duplicate_ids: 0 };
	}
	return {
		fetched_at: first.fetched_at,
		stale: metas.some((m) => m.stale),
		quarantined: metas.reduce((n, m) => n + (m.quarantined ?? 0), 0),
		duplicate_ids: metas.reduce((n, m) => n + (m.duplicate_ids ?? 0), 0),
	};
}

function badTermError(input: string): Error & { code: string; hint: string } {
	return Object.assign(
		new Error(`Unparseable term '${input}'. Use a term like FA2026.`),
		{
			code: "E_BAD_TERM",
			hint: "Use a term like FA2026 — run list_terms to see available terms.",
		},
	);
}

function usageError(
	message: string,
	hint: string,
): Error & {
	code: string;
	hint: string;
} {
	return Object.assign(new Error(message), { code: "E_USAGE", hint });
}

/** Normalize an explicit term option; undefined → defaultTerm. Throws E_BAD_TERM. */
async function resolveTerm(
	raw: string | undefined,
	fetchFn?: typeof fetch,
): Promise<string> {
	if (raw === undefined) return defaultTerm(fetchFn);
	const norm = normalizeTerm(raw);
	if (!norm) throw badTermError(raw);
	return norm.toUpperCase();
}

/**
 * Load one term. E_TERM_NOT_FOUND either throws (default) with the available
 * terms attached, or — when the caller explicitly opted in — serves the
 * newest available term with {fallback, warning}. Silent substitution is
 * never the default: an agent asked about SP2027 must not be answered with
 * FA2026 data plus a warning string it might drop.
 */
async function loadTermStrict(
	term: string,
	fetchFn: typeof fetch | undefined,
	allowFallback: boolean,
): Promise<{
	sections: Section[];
	meta: CacheMeta;
	fallback?: TermFallback;
	warning?: string;
}> {
	try {
		const value = await loadTerm(term, { fetchFn });
		return value;
	} catch (err) {
		const e = err as Error & { code?: string };
		if (e.code !== "E_TERM_NOT_FOUND") throw err;
		if (!allowFallback) {
			try {
				const { available } = await listTerms({ limit: 8, fetchFn });
				(e as Error & { available?: string[] }).available = available.map(
					(t) => t.code,
				);
			} catch {
				// keep the original error as-is
			}
			(e as Error & { hint?: string }).hint =
				"Term not published upstream. Run list_terms for available terms, or opt into serving the newest available term.";
			throw e;
		}
		const { available } = await listTerms({ limit: 8, fetchFn });
		const served = available[0]?.code;
		if (!served || served === term) throw err;
		const value = await loadTerm(served, { fetchFn });
		return {
			...value,
			fallback: { requested: term, served },
			warning: `Term ${term} is not published; showing ${served} instead.`,
		};
	}
}

// ---------- per-input ID resolution (the no-fabrication core) ----------

/** A parsed input that names one section completely (dept+number+school+section). */
type CompleteIdentity = ParsedCode & {
	dept: string;
	number: number;
	school: string;
	sectionNo: number;
};

function isCompleteIdentity(parsed: ParsedCode): parsed is CompleteIdentity {
	return (
		!!parsed.dept &&
		parsed.number !== undefined &&
		!!parsed.school &&
		parsed.sectionNo !== undefined
	);
}

interface Resolution {
	section?: Section;
	ambiguous?: string[];
}

/**
 * Resolve one input against one term's sections.
 * - Complete identity (dept+number+school+section): exact canonical match or
 *   miss. A wrong section number is a miss, never a silent sibling pick.
 * - Loose input: resolves only when it is UNIQUE; multiple matches are
 *   returned as candidates for the caller to disambiguate.
 * - Garbage (no dept and no number): always a miss, never the first section.
 */
function resolveInput(
	input: string,
	parsed: ParsedCode,
	targetTerm: string,
	sections: Section[],
	strict: boolean,
): Resolution {
	if (isCompleteIdentity(parsed)) {
		const canonical = sectionId({
			dept: parsed.dept,
			number: parsed.number,
			suffix: parsed.suffix ?? "",
			school: parsed.school,
			sectionNo: parsed.sectionNo,
			term: targetTerm,
		});
		const exact = sections.find((s) => s.id === canonical);
		return exact ? { section: exact } : {};
	}
	if (strict) return {}; // schedule ops require exact identities
	if (!parsed.dept && parsed.number === undefined) return {}; // garbage
	const matches = sections.filter(
		(s) =>
			(!parsed.dept || s.dept === parsed.dept) &&
			(parsed.number === undefined || s.number === parsed.number) &&
			(!parsed.suffix || s.suffix === parsed.suffix) &&
			(!parsed.school || s.school === parsed.school) &&
			(parsed.sectionNo === undefined || s.sectionNo === parsed.sectionNo),
	);
	if (matches.length === 1) return { section: matches[0] };
	if (matches.length > 1) return { ambiguous: matches.map((s) => s.id) };
	return {};
}

/** Load every term a batch of inputs needs; returns per-term provenance. */
async function loadTermsForInputs(
	termKeys: string[],
	fetchFn: typeof fetch | undefined,
	allowFallback: boolean,
): Promise<{
	loaded: Map<string, { sections: Section[]; meta: CacheMeta }>;
	terms: TermProvenance[];
	fallback?: TermFallback;
	warning?: string;
}> {
	const loaded = new Map<string, { sections: Section[]; meta: CacheMeta }>();
	const terms: TermProvenance[] = [];
	let fallback: TermFallback | undefined;
	let warning: string | undefined;
	for (const t of termKeys) {
		const v = await loadTermStrict(t, fetchFn, allowFallback);
		if (v.fallback && !fallback) {
			fallback = v.fallback;
			warning = v.warning;
		}
		loaded.set(v.meta.term, { sections: v.sections, meta: v.meta });
		terms.push({
			term: v.meta.term,
			fetched_at: v.meta.fetched_at,
			stale: v.meta.stale,
		});
	}
	return { loaded, terms, ...(fallback ? { fallback, warning } : {}) };
}

function validateIdList(ids: unknown): asserts ids is string[] {
	if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
		throw usageError(
			"Expected an array of section ID strings.",
			"Pass IDs like 'CSCI 005 HM-01 FA2026'.",
		);
	}
}

// ---------- search ----------

export async function searchClasses(
	query: string,
	opts: {
		term?: string;
		schools?: string[] | string;
		depts?: string[] | string;
		code?: string;
		days?: string;
		after?: string;
		before?: string;
		instructor?: string;
		areas?: string[] | string;
		credits?: string;
		open?: boolean;
		excludeConflictsWith?: string[];
		limit?: number;
		offset?: number;
		sort?: "relevance" | "time" | "seats" | "code";
		explain?: boolean;
		/** Opt in to serving the newest available term when the requested one is unpublished. */
		allowTermFallback?: boolean;
	} & EngineOptions = {},
): Promise<{
	result: SearchResult;
	normalized: Record<string, unknown>;
	meta: SnapshotMeta;
	fallback?: TermFallback;
	warning?: string;
}> {
	// Validation BEFORE any fetch: bad filters must exit 2 offline, instantly.
	const filters = normalizeFilters({
		school: opts.schools,
		dept: opts.depts,
		days: opts.days,
		after: opts.after,
		before: opts.before,
		instructor: opts.instructor,
		area: opts.areas,
		credits: opts.credits,
		open: opts.open,
		excludeConflictsWith: opts.excludeConflictsWith,
	});
	// --code is a hard prefix constraint derived from loose input.
	// Digit rule: 1 or 3 digits mean the exact course number ("CSCI 5" ->
	// 005, "CSCI 051" -> 051); 2 digits are the zero-padded family
	// ("CSCI 05" -> 050-059), matching the documented behavior.
	if (opts.code !== undefined && opts.code.trim() !== "") {
		const parsed = parseCode(opts.code);
		if (!parsed.dept && parsed.number === undefined) {
			throw new FilterError(
				`Unparseable --code '${opts.code}'.`,
				"Try --code 'CSCI 051', --code CSCI, or --code 'CSCI 051 PO'.",
			);
		}
		if (parsed.dept) {
			let prefix = parsed.dept;
			if (parsed.numberRaw !== undefined) {
				prefix +=
					parsed.numberRaw.length === 2
						? parsed.numberRaw
						: parsed.numberRaw.padStart(3, "0");
			}
			if (parsed.suffix) prefix += parsed.suffix;
			filters.codePrefix = prefix;
			if (parsed.school && !filters.schools) {
				filters.schools = [parsed.school];
			}
		}
	}
	const requested = await resolveTerm(opts.term, opts.fetchFn);
	const { sections, meta, fallback, warning } = await loadTermStrict(
		requested,
		opts.fetchFn,
		opts.allowTermFallback ?? false,
	);
	const served = fallback?.served ?? requested;
	const provider = getProvider(served, sections, meta.hash);
	let hits = provider.query(query ?? "", filters);
	hits = sortHits(hits, opts.sort ?? "relevance");
	// exclude-conflicts-with: anchors must resolve EXACTLY in the served term.
	// A mistyped anchor silently returning everything is worse than an error.
	if (filters.excludeConflictIds && filters.excludeConflictIds.length > 0) {
		// Local binding: narrowing has to survive into the filter callbacks.
		const anchors = filters.excludeConflictIds;
		const missing = anchors.filter((id) => !sections.some((s) => s.id === id));
		if (missing.length > 0) {
			throw Object.assign(
				new Error(
					`Unknown exclusion anchor(s): ${missing.join(", ")}. Anchors must be canonical IDs in the searched term.`,
				),
				{
					code: "E_NOT_FOUND",
					not_found: missing,
					hint: "Resolve IDs via search first, then pass them verbatim.",
				},
			);
		}
		const anchored = sections.filter((s) => anchors.includes(s.id));
		hits = hits.filter(
			(h) =>
				!anchors.includes(h.section.id) &&
				!anchored.some(
					(a) => a.id !== h.section.id && sectionsOverlap(a, h.section),
				),
		);
	}
	const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
	const offset = Math.max(opts.offset ?? 0, 0);
	const suggestions = recallSuggestions(query ?? "", filters, sections);
	if (resultWillBeEmptyCodeQuery(query ?? "", hits)) {
		const parsed = parseCode(query ?? "");
		const label =
			`${parsed.dept} ${String(parsed.number).padStart(3, "0")}${parsed.suffix ?? ""}`.trim();
		suggestions.unshift(
			`No ${label} in ${served} — check the course number, or browse with --dept ${parsed.dept} (departments:["${parsed.dept}"]).`,
		);
	}
	const result = paginate(hits, {
		limit,
		offset,
		term: served,
		fetched_at: meta.fetched_at,
		stale: meta.stale,
		explain: opts.explain ?? false,
		snapshot_id: meta.hash.slice(0, 12),
		suggestions,
	});
	return {
		result,
		normalized: { ...filters.normalized, term: served },
		meta: snapshotMeta(meta),
		...(fallback ? { fallback, warning } : {}),
	};
}

// ---------- get / check ----------

const MAX_IDS = 20;

export async function getClasses(
	ids: string[],
	opts: { term?: string; allowTermFallback?: boolean } & EngineOptions = {},
): Promise<{
	result: GetResult;
	meta: SnapshotMeta;
	terms: TermProvenance[];
	fallback?: TermFallback;
	warning?: string;
}> {
	validateIdList(ids);
	if (ids.length === 0) {
		throw usageError(
			"get needs at least one ID.",
			"Pass 1-20 canonical section IDs.",
		);
	}
	// No silent truncation: an over-cap batch is a caller error.
	if (ids.length > MAX_IDS) {
		throw usageError(
			`Too many IDs (${ids.length}); the cap is ${MAX_IDS}.`,
			"Split the batch into multiple calls.",
		);
	}
	const explicitTerm =
		opts.term !== undefined
			? await resolveTerm(opts.term, opts.fetchFn)
			: undefined;
	const inputs = ids.map((id) => ({ id, parsed: parseCode(id) }));
	const needDefault =
		explicitTerm === undefined && inputs.some((x) => !x.parsed.term);
	const defTerm = needDefault ? await defaultTerm(opts.fetchFn) : null;
	const termKey = (x: { parsed: ParsedCode }): string => {
		const t = x.parsed.term ?? explicitTerm ?? defTerm;
		if (!t) throw badTermError("");
		return t;
	};
	const distinctTerms = [...new Set(inputs.map(termKey))];
	const { loaded, terms, fallback, warning } = await loadTermsForInputs(
		distinctTerms,
		opts.fetchFn,
		opts.allowTermFallback ?? false,
	);
	const classes: Section[] = [];
	const not_found: string[] = [];
	const ambiguous: { input: string; section_ids: string[] }[] = [];
	const suggestions: { input: string; ids: string[] }[] = [];
	for (const x of inputs) {
		const t = termKey(x);
		const { sections } = loaded.get(t) ?? { sections: [] as Section[] };
		const res = resolveInput(x.id, x.parsed, t, sections, false);
		const section = res.section;
		if (section) {
			if (!classes.some((c) => c.id === section.id)) classes.push(section);
			continue;
		}
		if (res.ambiguous && res.ambiguous.length > 0) {
			ambiguous.push({ input: x.id, section_ids: res.ambiguous });
			continue;
		}
		not_found.push(x.id);
		const sug = suggestIds(sections, x.id);
		if (sug.length > 0) suggestions.push({ input: x.id, ids: sug });
	}
	return {
		result: { classes, not_found, ambiguous, suggestions, terms },
		meta: combinedMeta([...loaded.values()].map((v) => v.meta)),
		terms,
		...(fallback ? { fallback, warning } : {}),
	};
}

export async function checkScheduleByIds(
	ids: string[],
	opts: {
		term?: string;
		allowTermFallback?: boolean;
		passingMinutes?: number;
	} & EngineOptions = {},
): Promise<{
	result: CheckResult;
	sections: Section[];
	resolved: string[];
	meta: SnapshotMeta;
	terms: TermProvenance[];
	fallback?: TermFallback;
	warning?: string;
}> {
	validateIdList(ids);
	if (ids.length === 0) {
		throw usageError(
			"check needs at least one ID.",
			"Pass canonical section IDs, e.g. 'CSCI 005 HM-01 FA2026'.",
		);
	}
	if (ids.length > MAX_IDS) {
		throw usageError(
			`Too many IDs (${ids.length}); the cap is ${MAX_IDS}.`,
			"Split the schedule into multiple checks.",
		);
	}
	const explicitTerm =
		opts.term !== undefined
			? await resolveTerm(opts.term, opts.fetchFn)
			: undefined;
	const inputs = ids.map((id) => ({ id, parsed: parseCode(id) }));
	const needDefault =
		explicitTerm === undefined && inputs.some((x) => !x.parsed.term);
	const defTerm = needDefault ? await defaultTerm(opts.fetchFn) : null;
	const termKey = (x: { parsed: ParsedCode }): string => {
		const t = x.parsed.term ?? explicitTerm ?? defTerm;
		if (!t) throw badTermError("");
		return t;
	};
	const distinctTerms = [...new Set(inputs.map(termKey))];
	const { loaded, terms, fallback, warning } = await loadTermsForInputs(
		distinctTerms,
		opts.fetchFn,
		opts.allowTermFallback ?? false,
	);
	// Strict: every input must resolve to exactly one known section.
	const resolved: Section[] = [];
	const failed: string[] = [];
	for (const x of inputs) {
		const t = termKey(x);
		const { sections } = loaded.get(t) ?? { sections: [] as Section[] };
		const res = resolveInput(x.id, x.parsed, t, sections, true);
		const section = res.section;
		if (section) {
			if (!resolved.some((s) => s.id === section.id)) resolved.push(section);
		} else {
			failed.push(x.id);
		}
	}
	if (failed.length > 0) {
		throw Object.assign(
			new Error(
				`Unknown or incomplete section ID(s): ${failed.join(", ")}. Schedule checks need full IDs (dept, number, school, section, term).`,
			),
			{
				code: "E_NOT_FOUND",
				not_found: failed,
				hint: "Search first, then pass IDs like 'CSCI 005 HM-01 FA2026' verbatim.",
			},
		);
	}
	// Conflict math is term-scoped: comparing FA2026 against SP2026 is noise.
	const resolvedTerms = [...new Set(resolved.map((s) => s.term))];
	if (resolvedTerms.length > 1) {
		throw usageError(
			`check is term-scoped; these IDs span ${resolvedTerms.join(", ")}.`,
			"Run one check per term.",
		);
	}
	const result = checkSchedule(resolved, {
		passingMinutes: opts.passingMinutes,
	});
	return {
		result,
		sections: resolved,
		resolved: resolved.map((s) => s.id),
		meta: combinedMeta([...loaded.values()].map((v) => v.meta)),
		terms,
		...(fallback ? { fallback, warning } : {}),
	};
}

// ---------- terms ----------

export async function listTerms(
	opts: { limit?: number } & EngineOptions = {},
): Promise<{ current: string; available: TermInfo[] }> {
	const res = await fetchAllTerms({}, opts.fetchFn);
	let current = "FA2026";
	try {
		const cur = await fetchCurrentTerm({}, opts.fetchFn);
		current = `${cur.data.term}${cur.data.year}`;
	} catch {
		// fall back to the most recent available term (calendar order)
		const all = res.data
			.map((t) => `${t.term}${t.year}`)
			.sort(compareTermRecencyDesc);
		current = all[0] ?? current;
	}
	const limit = opts.limit ?? 6;
	const infos: TermInfo[] = res.data
		.map((t) => {
			const code = `${t.term}${t.year}`;
			return {
				code,
				label: termLabel(code),
				year: t.year,
				term: t.term,
				is_current: code === current,
			};
		})
		.sort((a, b) => compareTermRecencyDesc(a.code, b.code));
	// Always include the current term; keep the result at `limit` entries.
	const sliced = infos.slice(0, limit);
	if (!sliced.some((t) => t.is_current)) {
		const cur = infos.find((t) => t.is_current);
		if (cur) {
			if (sliced.length === limit) sliced.pop();
			sliced.unshift(cur);
		}
	}
	return { current, available: sliced };
}

// ---------- history ----------

export async function getCourseHistory(
	code: string,
	opts: {
		campuses?: string[];
		limit?: number;
		term?: string;
		allowTermFallback?: boolean;
	} & EngineOptions = {},
): Promise<HistoryResult & { fallback?: TermFallback; warning?: string }> {
	const requested = await resolveTerm(opts.term, opts.fetchFn);
	const { sections, meta, fallback, warning } = await loadTermStrict(
		requested,
		opts.fetchFn,
		opts.allowTermFallback ?? false,
	);
	const served = fallback?.served ?? requested;
	const provenance = {
		// fetched_at/stale describe the HISTORY source; enrichment describes
		// the sections snapshot. Two sources, two clocks.
		snapshot_term: served,
		enrichment: {
			term: served,
			fetched_at: meta.fetched_at,
			stale: meta.stale,
		} as const,
	};
	let entries: RawHistoryEntry[] = [];
	let historyFreshness = { fetched_at: "", stale: false };
	try {
		const h = await loadHistory(served, { fetchFn: opts.fetchFn });
		entries = h.entries;
		historyFreshness = { fetched_at: h.fetched_at, stale: h.stale };
	} catch (err) {
		if ((err as { code?: string }).code !== "E_TERM_NOT_FOUND") throw err;
		// sections published but history not: probe below.
	}
	const result = courseHistory(entries, sections, code, {
		campuses: opts.campuses,
		limit: opts.limit,
		fetched_at: historyFreshness.fetched_at,
		stale: historyFreshness.stale,
		...provenance,
	});
	if (result.offerings.length > 0)
		return { ...result, ...(fallback ? { fallback, warning } : {}) };
	// Upstream history is per-term: a course absent from the current term won't
	// appear in its file. Probe other terms' history files FIRST (small), and
	// only loadTerm (2.5MB snapshot) for the ONE term that actually matches.
	try {
		const { available } = await listTerms({ limit: 8, fetchFn: opts.fetchFn });
		const seen = new Set([served]);
		for (const t of available.map((x) => x.code)) {
			if (seen.has(t)) continue;
			seen.add(t);
			try {
				const {
					entries: e2,
					fetched_at: hf,
					stale: hs,
				} = await loadHistory(t, {
					fetchFn: opts.fetchFn,
				});
				const probe = courseHistory(e2, [], code, {
					campuses: opts.campuses,
					limit: opts.limit,
					fetched_at: hf,
					stale: hs,
				});
				if (probe.offerings.length > 0) {
					const { sections: s2, meta: m2 } = await loadTerm(t, {
						fetchFn: opts.fetchFn,
					});
					const r2 = courseHistory(e2, s2, code, {
						campuses: opts.campuses,
						limit: opts.limit,
						fetched_at: hf,
						stale: hs,
						snapshot_term: t,
						enrichment: {
							term: t,
							fetched_at: m2.fetched_at,
							stale: m2.stale,
						},
					});
					return {
						...r2,
						rotation_note: `${r2.rotation_note} (Not offered in ${served}; history resolved via ${t}.)`,
						...(fallback ? { fallback, warning } : {}),
					};
				}
			} catch {
				continue;
			}
			if (seen.size >= 5) break;
		}
	} catch {
		// fall through to empty result
	}
	return { ...result, ...(fallback ? { fallback, warning } : {}) };
}

// ---------- current term ----------

export async function defaultTerm(fetchFn?: typeof fetch): Promise<string> {
	const now = Date.now();
	const mem = getCurrentTermMem();
	if (mem && now - mem.at < CURRENT_TERM_TTL_MS) {
		return mem.value;
	}
	// Disk before network: cacheDir()/current-term.json, 5-min TTL.
	let staleFile: string | null = null;
	try {
		const file = await readCurrentTermFile();
		if (file) {
			if (now - file.at < CURRENT_TERM_TTL_MS) {
				setCurrentTermMem(file.value, file.at);
				return file.value;
			}
			staleFile = file.value;
		}
	} catch {
		// no usable file
	}
	try {
		const cur = await fetchCurrentTerm({}, fetchFn);
		const value = `${cur.data.term}${cur.data.year}`;
		await writeCurrentTermFile(value);
		return value;
	} catch {
		// Stale-but-known beats a hardcoded guess; with NOTHING known, say so
		// instead of silently serving FA2026 forever.
		const known = mem?.value ?? staleFile;
		if (known) return known;
		throw Object.assign(
			new Error(
				"Cannot determine the current term: network unavailable and no cached value.",
			),
			{
				code: "E_NO_CURRENT_TERM",
				hint: "Pass an explicit term like --term FA2026, or run `5c terms` once while online.",
			},
		);
	}
}

// ---------- suggestions ----------

/** Suggest close matches for a bad ID (used for did_you_mean). */
export function suggestIds(sections: Section[], id: string, n = 3): string[] {
	const parsed = parseCode(id);
	const scored = sections.map((s) => {
		let score = 0;
		if (parsed.dept && s.dept === parsed.dept) score += 3;
		if (parsed.number !== undefined && s.number === parsed.number) score += 3;
		if (parsed.school && s.school === parsed.school) score += 2;
		return { s, score };
	});
	return scored
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
		.slice(0, n)
		.map((x) => x.s.id);
}

// ---------- recall hints ----------

function sortHits<T extends { section: Section; score: number }>(
	hits: T[],
	sort: "relevance" | "time" | "seats" | "code",
): T[] {
	const arr = [...hits];
	if (sort === "time") {
		arr.sort(
			(a, b) =>
				earliestStart(a.section) - earliestStart(b.section) ||
				a.section.id.localeCompare(b.section.id),
		);
	} else if (sort === "seats") {
		arr.sort(
			(a, b) =>
				b.section.seats.available - a.section.seats.available ||
				a.section.id.localeCompare(b.section.id),
		);
	} else if (sort === "code") {
		arr.sort((a, b) => a.section.id.localeCompare(b.section.id));
	}
	return arr;
}

function earliestStart(s: Section): number {
	const starts = s.meetings.map((m) => m.startMin);
	return starts.length > 0 ? Math.min(...starts) : Number.MAX_SAFE_INTEGER;
}

// Department colloquial names (whole-word matched) → codes. Codes verified
// against live FA2026 data. Powers the "text query is narrower than dept
// browse" recall hint — the #1 observed agent confusion ("computer science"
// → 2 hits vs --dept CSCI → 7).
const DEPT_NAMES: [name: string, code: string][] = [
	["computer science", "CSCI"],
	["mathematics", "MATH"],
	["economics", "ECON"],
	["psychology", "PSYC"],
	["physics", "PHYS"],
	["chemistry", "CHEM"],
	["biology", "BIOL"],
	["english", "ENGL"],
	["history", "HIST"],
	["philosophy", "PHIL"],
	["sociology", "SOC"],
	["anthropology", "ANTH"],
	["neuroscience", "NEUR"],
	["astronomy", "ASTR"],
	["geology", "GEOL"],
	["politics", "POLI"],
	["statistics", "MATH"],
	["ethics", "PHIL"],
	["arabic", "ARBC"],
	["spanish", "SPAN"],
	["portuguese", "PORT"],
	["film", "MS"],
	["media", "MS"],
	["music", "MUS"],
	["math", "MATH"],
	["art", "ART"],
];

/** True when the query is code-shaped (dept+number) but matched nothing. */
function resultWillBeEmptyCodeQuery(
	query: string,
	hits: { section: Section }[],
): boolean {
	if (hits.length > 0) return false;
	const parsed = parseCode(query);
	return !!parsed.dept && parsed.number !== undefined;
}

/**
 * Recall hints: when free text names a department or college but the matching
 * structured filter isn't set, say so. Callers surface these next to results.
 */
export function recallSuggestions(
	query: string,
	filters: Filters,
	sections: Section[],
): string[] {
	const out: string[] = [];
	const padded = ` ${query.toLowerCase().trim()} `;
	if (padded.trim().length === 0) return out;
	const asCode = parseCode(query);
	const codeShaped = !!asCode.dept && asCode.number !== undefined;
	// A code-shaped query ("MATH 019") needs no dept-browse advice.
	if (
		!codeShaped &&
		(!filters.departments || filters.departments.length === 0)
	) {
		for (const [name, code] of DEPT_NAMES) {
			if (
				padded.includes(` ${name} `) &&
				sections.some((s) => s.dept === code)
			) {
				out.push(
					`'${query.trim()}' matches department ${code} — retry with --dept ${code} (departments:["${code}"]) for full recall.`,
				);
				break;
			}
		}
	}
	if (!filters.schools || filters.schools.length === 0) {
		const mentioned = detectSchoolMention(query);
		if (mentioned) {
			out.push(
				`Query mentions a college — retry with --school ${mentioned} to narrow, or leave blank for all 5Cs.`,
			);
		}
	}
	return out;
}

// ---------- public surface ----------
// Narrow by design: adapters import these, nothing else. Internal modules
// (cache internals, hyperschedule client, raw schemas) are not part of the
// interface — import them from their modules in tests.

export { checkSchedule, sectionsOverlap } from "./conflicts.js";
export {
	cacheDir,
	peekTermMeta,
	readCurrentTermFile,
	refreshTerm,
} from "./cache.js";
export {
	compareTermRecencyDesc,
	isRegistrable,
	minTo12,
	minToStr,
	normalizeDays,
	normalizeSchool,
	normalizeTerm,
	normalizeTermSections,
	parseCode,
	parseTime,
	sectionId,
	termLabel,
} from "./normalize.js";
export { MiniSearchProvider, paginate } from "./search.js";
// Wire schemas stay in ONE place: adapters advertise the same shape core
// validates (e.g. MCP outputSchema for get_classes).
export { sectionSchema } from "./schema.js";
export type {
	CheckResult,
	CompactHit,
	Filters,
	GetResult,
	HistoryResult,
	SearchResult,
	SnapshotMeta,
	TermFallback,
	TermInfo,
	TermProvenance,
} from "./types.js";
export type { CacheMeta, Meeting, Section } from "./schema.js";
