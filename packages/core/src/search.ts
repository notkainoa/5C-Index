import MiniSearch from "minisearch";
import { matchesFilters } from "./filters.js";
import { parseCode } from "./normalize.js";
import type { Section } from "./schema.js";
import type { CompactHit, Filters, RankedHit, SearchResult } from "./types.js";

interface Doc {
	id: string;
	code: string;
	title: string;
	instructors: string;
	areas: string;
	description: string;
}

function toDoc(s: Section): Doc {
	return {
		id: s.id,
		code: `${s.dept} ${String(s.number).padStart(3, "0")}${s.suffix} ${s.school}`,
		title: s.title,
		instructors: s.instructors.join(" "),
		areas: s.areas.join(" "),
		description: s.description,
	};
}

/** Keep "CSCI051" + "CSCI 051" + "csci-051" -> ["csci","051","csci051"]. Exported for ranking. */
export function codeAwareTokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/([a-z])(\d)/g, "$1 $2")
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

const BOOST = {
	code: 5,
	title: 3,
	instructors: 2.5,
	areas: 1.5,
	description: 1,
};

export class MiniSearchProvider {
	private mini: MiniSearch<Doc>;
	private byId = new Map<string, Section>();
	private docs: Doc[] = [];
	private built = false;

	constructor() {
		this.mini = new MiniSearch<Doc>({
			fields: ["code", "title", "instructors", "areas", "description"],
			storeFields: ["id", "code", "title"],
			searchOptions: {
				boost: BOOST,
				prefix: true,
				fuzzy: 0.3,
				combineWith: "AND",
			},
			tokenize: codeAwareTokenize,
			processTerm: (t) => t.toLowerCase(),
		});
	}

	build(sections: Section[]): void {
		this.setSections(sections);
		this.ensureIndex();
	}

	/** Cheap path: byId only, no MiniSearch build (~65-90ms saved). */
	setSections(sections: Section[]): void {
		this.byId = new Map(sections.map((s) => [s.id, s]));
		this.docs = sections.map(toDoc);
		this.built = false;
		this.mini.removeAll();
	}

	/** Build the MiniSearch index on first full-text need. Idempotent. */
	ensureIndex(): void {
		if (this.built) return;
		this.mini.removeAll();
		if (this.docs.length > 0) this.mini.addAll(this.docs);
		this.built = true;
	}

	get indexBuilt(): boolean {
		return this.built;
	}

	/**
	 * Candidate-union pipeline. Deterministic pre-passes (exact code, code
	 * prefix, dept) contribute scored candidates; free-text queries union
	 * title-phrase candidates with full-text results. Hard filters apply
	 * ONCE over the union, so a filter narrower than a pre-pass can never
	 * silently delete valid matches. Code-shaped queries stay strict: a
	 * dept+number that matches nothing is "not found", never fuzzy soup.
	 */
	query(q: string, f: Filters): RankedHit[] {
		const query = q.trim();
		const tokens = codeAwareTokenize(query);
		const parsed = parseCode(query);
		const all = [...this.byId.values()];
		const cand = new Map<
			string,
			{ s: Section; score: number; why: string[] }
		>();

		const add = (s: Section, score: number, why: string[]): void => {
			const cur = cand.get(s.id);
			if (!cur) {
				cand.set(s.id, { s, score, why: [...why] });
				return;
			}
			if (score > cur.score) cur.score = score;
			for (const w of why) if (!cur.why.includes(w)) cur.why.push(w);
		};

		const codeShaped = !!parsed.dept && parsed.number !== undefined;
		if (codeShaped) {
			const num = String(parsed.number).padStart(3, "0");
			const exact = all.filter(
				(s) =>
					s.dept === parsed.dept &&
					String(s.number).padStart(3, "0") === num &&
					s.suffix === (parsed.suffix ?? "") &&
					(!parsed.school || s.school === parsed.school),
			);
			if (exact.length > 0) {
				for (const s of exact) add(s, 100, ["exact-code"]);
				return this.finalize([...cand.values()], f, tokens);
			}
			// Code prefix: dept + leading digits, UNPADDED so "PSYC 14"
			// matches PSYC 140-149 (padded "014" would only match PSYC 014).
			// School/suffix from the query are honored on this path too.
			const prefix = `${parsed.dept}${parsed.number}`.toLowerCase();
			const prefixed = all.filter(
				(s) =>
					s.dept === parsed.dept &&
					(!parsed.suffix || s.suffix === parsed.suffix) &&
					(!parsed.school || s.school === parsed.school) &&
					`${s.dept}${s.number}`.toLowerCase().startsWith(prefix),
			);
			if (prefixed.length > 0) {
				for (const s of prefixed) add(s, 50, ["code-prefix"]);
				return this.finalize([...cand.values()], f, tokens);
			}
			// Code-shaped query ("QQQ 000") that matches nothing: empty,
			// never fuzzy description matches.
			return this.finalize([], f, tokens);
		}

		if (parsed.dept && parsed.number === undefined) {
			// dept-only, e.g. "csci" (school honored when the query names one)
			const deptHit = all.filter(
				(s) =>
					s.dept === parsed.dept &&
					(!parsed.school || s.school === parsed.school),
			);
			for (const s of deptHit) add(s, 50, ["dept"]);
		}

		if (query.length === 0) {
			// Browse mode: every section that survives filters.
			for (const s of all) add(s, 1, ["browse"]);
			return this.finalize([...cand.values()], f, tokens);
		}

		// Title-phrase candidates: merged into the union (no early return —
		// an early return here used to hide filtered-out full-text matches).
		const phrase = query.replace(/^"|"$/g, "").toLowerCase();
		if (phrase.length >= 4) {
			for (const s of all.filter((x) => x.title.toLowerCase().includes(phrase)))
				add(s, 30, ["title-phrase"]);
		}

		// Full-text: AND first; empty + 2+ tokens -> OR retry so a single
		// typo'd word alongside a good one still yields useful hits.
		this.ensureIndex();
		let results = this.mini.search(query);
		let orFallback = false;
		if (results.length === 0 && tokens.length > 1) {
			results = this.mini.search(query, { combineWith: "OR" });
			orFallback = true;
		}
		const ql = query.toLowerCase();
		for (const r of results) {
			const s = this.byId.get(r.id);
			if (!s) continue;
			const why: string[] = [];
			if (s.title.toLowerCase().includes(ql)) why.push(`title:${ql}`);
			if (s.dept.toLowerCase() === ql || s.code.toLowerCase().startsWith(ql)) {
				why.push(`code:${ql}`);
			}
			if (s.instructors.some((i) => i.toLowerCase().includes(ql))) {
				why.push(`instructor:${ql}`);
			}
			let score = r.score;
			if (orFallback) {
				const coverage = Object.keys(r.match ?? {}).length;
				score = r.score * 0.5 * (1 + coverage);
				why.push("or-fallback");
			}
			add(s, score, why.length > 0 ? why : ["text"]);
		}
		return this.finalize([...cand.values()], f, tokens);
	}

	private finalize(
		scored: { s: Section; score: number; why: string[] }[],
		f: Filters,
		queryTokens: string[] = [],
	): RankedHit[] {
		// Filters are hard constraints; modifiers adjust score only.
		// All seat/status adjustments happen HERE, once, for every path.
		const out: RankedHit[] = [];
		for (const { s, score, why } of scored) {
			if (!matchesFilters(s, f)) continue;
			let adj = score;
			// Whole-word title match ("organic" should not lose to "inorganic").
			if (queryTokens.length > 0) {
				const titleTokens = new Set(codeAwareTokenize(s.title));
				if (queryTokens.every((t) => titleTokens.has(t))) {
					adj += 8;
					why.push("title-words");
				}
			}
			if (s.status === "O") adj += 5;
			else if (s.status === "C") adj -= 10;
			else if (s.status === "R") adj += 2;
			if (s.seats.available >= 3) adj += 3;
			else if (s.seats.available > 0) adj += 1;
			if (s.potentialError) adj -= 5;
			out.push({
				section: s,
				score: adj,
				match: why,
				fetched_at: "",
				stale: false,
			});
		}
		out.sort(
			(a, b) =>
				b.score - a.score ||
				b.section.seats.available - a.section.seats.available ||
				a.section.id.localeCompare(b.section.id),
		);
		return out;
	}

	toJSON(): string {
		this.ensureIndex();
		return JSON.stringify({
			index: this.mini.toJSON(),
			ids: [...this.byId.keys()],
		});
	}

	get size(): number {
		return this.byId.size;
	}
}

// NOTE: hard-constraint filtering lives in filters.ts matchesFilters (single
// source of truth). This module only ranks survivors.

function mergedDays(s: Section): string {
	const order = ["M", "T", "W", "R", "F", "S", "U"];
	const set = new Set<string>(s.meetings.flatMap((m) => m.days));
	return order.filter((d) => set.has(d)).join("");
}

export function toCompactHit(
	h: RankedHit,
	fetched_at: string,
	explain: boolean,
	stale = false,
): CompactHit {
	const s = h.section;
	return {
		id: s.id,
		term: s.term,
		school: s.school,
		code: s.code,
		section: String(s.sectionNo).padStart(2, "0"),
		title: s.title,
		instructors: s.instructors,
		// Summary across meetings; the per-block truth is in meetings[].
		days: mergedDays(s),
		start: s.meetings.length > 0 ? s.meetings[0].startStr : null,
		end: s.meetings.length > 0 ? s.meetings[0].endStr : null,
		meetings:
			s.meetings.length === 0
				? []
				: s.meetings.map((m) => ({
						days: m.days.join(""),
						start: m.startStr,
						end: m.endStr,
						location: m.locations[0] ?? null,
					})),
		credits: s.credits,
		potential_error: s.potentialError,
		seats_open: s.seats.available,
		seats_total: s.seats.total,
		status: s.status,
		match: {
			score: Math.round(h.score * 100) / 100,
			why: explain ? h.match : h.match.slice(0, 1),
		},
		fetched_at,
		stale,
	};
}

export function paginate(
	hits: RankedHit[],
	opts: {
		limit: number;
		offset: number;
		term: string;
		fetched_at: string;
		stale: boolean;
		explain: boolean;
		snapshot_id?: string | null;
		suggestions?: string[];
	},
): SearchResult {
	const total = hits.length;
	const slice = hits.slice(opts.offset, opts.offset + opts.limit);
	const has_more = opts.offset + opts.limit < total;
	const hint =
		total === 0
			? "No matches. Try fewer filters, a different term, or drop --open."
			: opts.offset >= total
				? `Offset ${opts.offset} is past the end (total ${total}); re-run with --offset 0 or narrow filters.`
				: has_more
					? `${total} hits, showing ${slice.length}. Re-run with --offset ${opts.offset + opts.limit} or narrow filters.`
					: null;
	return {
		term: opts.term,
		total,
		limit: opts.limit,
		offset: opts.offset,
		has_more,
		next_offset: has_more ? opts.offset + opts.limit : null,
		hits: slice.map((h) =>
			toCompactHit(h, opts.fetched_at, opts.explain, opts.stale),
		),
		hint,
		suggestions: opts.suggestions ?? [],
		fetched_at: opts.fetched_at,
		stale: opts.stale,
		snapshot_id: opts.snapshot_id ?? null,
	};
}
