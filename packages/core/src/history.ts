import {
	compareTermRecencyDesc,
	normalizeSchool,
	parseCode,
	termLabel,
} from "./normalize.js";
import type { RawHistoryEntry } from "./schema.js";
import type { HistoryOffering, HistoryResult, Section } from "./types.js";

/**
 * Offering-history join. HyperSchedule's /offering-history/:term gives
 * {code, terms[]} keyed by affiliation. We match on FULL course identity
 * (dept + number + suffix, affiliation from the query or campus filter),
 * enrich with instructors/seats from a snapshot when available, and phrase
 * every verdict from the window we actually observed.
 */

function emptyHistory(
	codeQuery: string,
	note: string,
	provenance: Pick<HistoryResult, "fetched_at" | "stale" | "snapshot_term"> &
		Pick<HistoryResult, "enrichment">,
): HistoryResult {
	return {
		code: codeQuery.trim().toUpperCase().slice(0, 32),
		offerings: [],
		rotation_note: note,
		verdict: "No history found.",
		...provenance,
	};
}

export function courseHistory(
	entries: RawHistoryEntry[],
	sections: Section[],
	codeQuery: string,
	opts: {
		campuses?: string[];
		limit?: number;
		fetched_at?: string;
		stale?: boolean;
		snapshot_term?: string;
		enrichment?: { term: string; fetched_at: string; stale: boolean } | null;
	} = {},
): HistoryResult {
	const limit = opts.limit ?? 6;
	const provenance = {
		fetched_at: opts.fetched_at ?? "",
		stale: opts.stale ?? false,
		snapshot_term: opts.snapshot_term ?? "",
		enrichment: opts.enrichment ?? null,
	};
	const parsed = parseCode(codeQuery);
	// Unparseable input ("blarg 999", empty) must yield empty — never the
	// longest history in the file (same no-fabrication rule as getClasses).
	if (!parsed.dept && parsed.number === undefined) {
		return emptyHistory(
			codeQuery,
			`No offering history found for '${codeQuery}'. Try a course code like 'CSCI 151'.`,
			provenance,
		);
	}
	if (parsed.number === undefined) {
		return emptyHistory(
			codeQuery,
			"History needs a course number, e.g. 'CSCI 151'. Department-only queries match too many courses.",
			provenance,
		);
	}

	// Identity match: dept + number (+ suffix when the query carries one).
	const matched = entries.filter(
		(e) =>
			e.code.department.toUpperCase() === parsed.dept &&
			e.code.courseNumber === parsed.number &&
			(parsed.suffix
				? (e.code.suffix ?? "").toUpperCase() === parsed.suffix
				: true),
	);
	if (matched.length === 0) {
		return emptyHistory(
			codeQuery,
			`No offering history found for '${codeQuery}'.`,
			provenance,
		);
	}

	// Group by affiliation. The school in the query and the campus filter are
	// both honored — a query for "CSCI 005 PO" must never answer with Mudd.
	const byAff = new Map<string, RawHistoryEntry[]>();
	for (const e of matched) {
		const aff = e.code.affiliation.toUpperCase();
		const list = byAff.get(aff) ?? [];
		list.push(e);
		byAff.set(aff, list);
	}
	const campusFilter = (opts.campuses ?? []).map(normalizeSchool);
	const wantedSchools = parsed.school
		? [parsed.school]
		: campusFilter.length > 0
			? campusFilter
			: [...byAff.keys()];

	const available = wantedSchools.filter((s) => byAff.has(s));
	if (available.length === 0) {
		return emptyHistory(
			codeQuery,
			`No offering history for ${parsed.dept} ${String(parsed.number).padStart(3, "0")} at ${wantedSchools.join(", ")}; it exists at ${[...byAff.keys()].join(", ")}.`,
			provenance,
		);
	}

	// Best entry per affiliation (longest history wins within an affiliation).
	const chosen = available.map((school) => {
		const list = [...(byAff.get(school) ?? [])].sort(
			(a, b) => b.terms.length - a.terms.length,
		);
		return { school, entry: list[0] };
	});

	const byTerm = new Map<string, Section[]>();
	for (const s of sections) {
		const group = byTerm.get(s.term) ?? [];
		group.push(s);
		byTerm.set(s.term, group);
	}

	// Enrich joins on the SAME identity (incl. school + suffix).
	const enrichFor = (school: string, termKey: string): Section[] =>
		(byTerm.get(termKey) ?? []).filter(
			(s) =>
				s.dept === parsed.dept &&
				s.number === parsed.number &&
				(!parsed.suffix || s.suffix === parsed.suffix) &&
				s.school === school,
		);

	const allTermKeys = chosen.flatMap(({ school, entry }) =>
		entry.terms.map((t) => ({ school, key: `${t.term}${t.year}` })),
	);
	const code = `${parsed.dept} ${String(parsed.number).padStart(3, "0")}${parsed.suffix ?? ""}`;
	const sortedKeys = [...new Set(allTermKeys.map((x) => x.key))].sort(
		compareTermRecencyDesc,
	);

	const offerings: HistoryOffering[] = [];
	for (const key of sortedKeys.slice(0, limit)) {
		for (const { school, entry } of chosen) {
			if (!entry.terms.some((t) => `${t.term}${t.year}` === key)) continue;
			const inTerm = enrichFor(school, key);
			const instructors = [...new Set(inTerm.flatMap((s) => s.instructors))];
			const first = inTerm[0];
			offerings.push({
				term: key,
				instructors,
				campus: first?.school ?? school,
				seats: first
					? { capacity: first.seats.total, enrolled: first.seats.filled }
					: null,
			});
		}
	}

	// Observed window + cadence, phrased from the data we actually read.
	const windowKeys = [...new Set(allTermKeys.map((x) => x.key))].sort(
		compareTermRecencyDesc,
	);
	const span =
		windowKeys.length > 1
			? `${termLabel(windowKeys[windowKeys.length - 1])}–${termLabel(windowKeys[0])}`
			: termLabel(windowKeys[0] ?? "");
	const fa = windowKeys.filter((k) => k.startsWith("FA")).length;
	const sp = windowKeys.filter((k) => k.startsWith("SP")).length;
	const total = windowKeys.length;
	let cadence = "irregularly";
	if (fa > 0 && sp === 0) cadence = "fall-only";
	else if (sp > 0 && fa === 0) cadence = "spring-only";
	else if (fa > 0 && sp > 0) cadence = "both semesters";

	const shortWindow =
		total <= 2
			? " Short window; treat any rotation pattern as weak evidence."
			: "";

	if (chosen.length > 1) {
		const schools = chosen.map((c) => c.school).join(", ");
		return {
			code,
			offerings,
			rotation_note: `${code} has separate histories at ${schools}; offerings below are labeled by campus. Specify a school for a single-course verdict.`,
			verdict: `History exists at ${schools}; specify a school (e.g. '${code} ${chosen[0].school}') for a per-course verdict.`,
			...provenance,
		};
	}

	let verdict: string;
	if (fa > 0 && sp === 0) {
		verdict = `Fall-only in observed history (FA ${fa}, SP 0; window ${span}).${shortWindow}`;
	} else if (sp > 0 && fa === 0) {
		verdict = `Spring-only in observed history (SP ${sp}, FA 0; window ${span}).${shortWindow}`;
	} else if (sp > fa + 1) {
		verdict = `Usually spring (SP ${sp} vs FA ${fa} in window ${span}).${shortWindow}`;
	} else if (fa > sp + 1) {
		verdict = `Usually fall (FA ${fa} vs SP ${sp} in window ${span}).${shortWindow}`;
	} else {
		verdict = `Offered both semesters (FA ${fa}, SP ${sp} in window ${span}).${shortWindow}`;
	}
	const rotation_note = `Offered in ${total} term(s) across ${span} in available history (${cadence}: FA ${fa}, SP ${sp}). Instructors are only known for terms with a local snapshot.`;
	return { code, offerings, rotation_note, verdict, ...provenance };
}
