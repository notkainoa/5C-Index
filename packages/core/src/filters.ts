import {
	isRegistrable,
	normalizeDays,
	normalizeSchool,
	parseTime,
} from "./normalize.js";
import type { Filters, Section } from "./types.js";

export interface NormalizedFilters extends Filters {
	normalized: Record<string, unknown>;
	warnings: string[];
}

export class FilterError extends Error {
	code = "E_BAD_FILTER";
	hint: string;
	constructor(message: string, hint: string) {
		super(message);
		this.hint = hint;
	}
}

/** Canonical school codes accepted by --school (aliases resolve before this check). */
export const KNOWN_SCHOOLS = [
	"PO",
	"CM",
	"HM",
	"SC",
	"PZ",
	"CG",
	"KS",
	"JP",
	"JT",
	"JM",
	"AF",
	"CH",
	"AA",
] as const;

const SCHOOLS_HINT = `Valid: ${KNOWN_SCHOOLS.join(" ")} (codes or names like Pomona, CMC, Harvey Mudd).`;

/** Normalize raw user filter input. Throws FilterError (exit 2) on bad values. */
export function normalizeFilters(raw: {
	school?: string[] | string;
	dept?: string[] | string;
	days?: string;
	after?: string;
	before?: string;
	instructor?: string;
	area?: string[] | string;
	credits?: string;
	creditsMin?: number;
	creditsMax?: number;
	open?: boolean;
	excludeConflictsWith?: string[];
}): NormalizedFilters {
	const out: NormalizedFilters = { normalized: {}, warnings: [] };
	const list = (v: string[] | string | undefined): string[] =>
		v === undefined ? [] : Array.isArray(v) ? v : [v];

	const schools = list(raw.school);
	if (schools.length > 0) {
		out.schools = schools.map((s) => {
			const code = normalizeSchool(s);
			if (!(KNOWN_SCHOOLS as readonly string[]).includes(code)) {
				throw new FilterError(`Unknown school '${s}'.`, SCHOOLS_HINT);
			}
			return code;
		});
		out.normalized.school = out.schools;
	}
	const depts = list(raw.dept);
	if (depts.length > 0) {
		out.departments = depts.map((d) => {
			const clean = d.trim().toUpperCase();
			// Reject rather than launder: "C-S-I" must not silently become "CSI".
			if (!/^[A-Z]{2,4}$/.test(clean)) {
				throw new FilterError(
					`Bad --dept '${d}'.`,
					"Use 2–4 letter codes, e.g. --dept CSCI MATH.",
				);
			}
			return clean;
		});
		out.normalized.dept = out.departments;
	}
	if (raw.days) {
		const days = normalizeDays(raw.days);
		if (!days) {
			throw new FilterError(
				`Unknown days '${raw.days}'.`,
				"Valid: M T W R F S U combos like MWF, TR, T/R, TuTh. R=Thursday.",
			);
		}
		out.days = days;
		out.normalized.days = days.join("");
	}
	if (raw.after) {
		const min = parseTime(raw.after);
		if (min === null) {
			throw new FilterError(
				`Unparseable time '${raw.after}'.`,
				"Try --after 1pm, --after 13:00, --after 10:00am.",
			);
		}
		out.afterMin = min;
		out.normalized.after = raw.after;
	}
	if (raw.before) {
		const min = parseTime(raw.before);
		if (min === null) {
			throw new FilterError(
				`Unparseable time '${raw.before}'.`,
				"Try --before 5pm, --before 17:00.",
			);
		}
		out.beforeMin = min;
		out.normalized.before = raw.before;
	}
	if (
		out.afterMin !== undefined &&
		out.beforeMin !== undefined &&
		out.afterMin > out.beforeMin
	) {
		throw new FilterError(
			`Inverted time window: after ${raw.after} but before ${raw.before}.`,
			"The window must satisfy after <= before.",
		);
	}
	if (raw.instructor) {
		out.instructor = raw.instructor.trim();
		out.normalized.instructor = out.instructor;
	}
	const areas = list(raw.area);
	if (areas.length > 0) {
		out.areas = areas.map((a) => a.trim().toUpperCase());
		out.normalized.area = out.areas;
	}
	if (raw.credits) {
		const m = raw.credits.match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
		if (!m) {
			throw new FilterError(
				`Unparseable credits '${raw.credits}'.`,
				"Try --credits 1 or --credits 0.5-1.",
			);
		}
		out.creditsMin = Number.parseFloat(m[1]);
		out.creditsMax = m[2] ? Number.parseFloat(m[2]) : Number.parseFloat(m[1]);
	}
	if (raw.creditsMin !== undefined) out.creditsMin = raw.creditsMin;
	if (raw.creditsMax !== undefined) out.creditsMax = raw.creditsMax;
	if (raw.open !== undefined) out.openOnly = raw.open;
	if (raw.excludeConflictsWith && raw.excludeConflictsWith.length > 0) {
		out.excludeConflictIds = raw.excludeConflictsWith;
	}
	return out;
}

/** Hard-constraint predicate. Filters never affect score, only survival. */
export function matchesFilters(s: Section, f: Filters): boolean {
	// Anchors themselves are excluded (core conflictsWith skips self-matches,
	// so without this the anchor would survive its own exclusion list).
	if (
		f.excludeConflictIds &&
		f.excludeConflictIds.length > 0 &&
		f.excludeConflictIds.includes(s.id)
	) {
		return false;
	}
	if (f.schools && f.schools.length > 0 && !f.schools.includes(s.school))
		return false;
	if (
		f.departments &&
		f.departments.length > 0 &&
		!f.departments.includes(s.dept)
	) {
		return false;
	}
	if (f.codePrefix) {
		// Flat form includes the suffix so "--code 'CSCI 051L'" can match.
		const flat = `${s.dept}${String(s.number).padStart(3, "0")}${s.suffix}`;
		if (!flat.startsWith(f.codePrefix.toUpperCase())) return false;
	}
	if (f.days && f.days.length > 0) {
		const sectionDays = new Set<string>(s.meetings.flatMap((m) => m.days));
		if (s.meetings.length === 0) return false; // TBA can't satisfy a day filter
		for (const d of f.days) if (!sectionDays.has(d)) return false;
	}
	// Time windows are whole-schedule constraints: EVERY meeting must fit.
	// (Per-meeting ".some()" let split-block sections satisfy impossible
	// windows via different meetings — reproduced in contracts tests.)
	const afterMin = f.afterMin;
	if (afterMin !== undefined) {
		if (s.meetings.length === 0) return false;
		if (!s.meetings.every((m) => m.startMin >= afterMin)) return false;
	}
	const beforeMin = f.beforeMin;
	if (beforeMin !== undefined) {
		if (s.meetings.length === 0) return false;
		if (!s.meetings.every((m) => m.endMin <= beforeMin)) return false;
	}
	if (f.instructor) {
		const q = f.instructor.toLowerCase();
		if (!s.instructors.some((i) => i.toLowerCase().includes(q))) return false;
	}
	if (f.areas && f.areas.length > 0) {
		const upper = s.areas.map((a) => a.toUpperCase());
		if (!f.areas.some((a) => upper.includes(a))) return false;
	}
	if (f.creditsMin !== undefined && s.credits < f.creditsMin) return false;
	if (f.creditsMax !== undefined && s.credits > f.creditsMax) return false;
	// Availability policy: registrar status decides registrability; computed
	// capacity is never an eligibility signal (closed-but-spare sections
	// must not pass, over-enrolled-but-open ones are reported, not hidden).
	if (f.openOnly && !isRegistrable(s.status)) return false;
	return true;
}
