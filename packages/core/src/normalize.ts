import type { Meeting, RawSection, Section } from "./schema.js";

/**
 * Normalization: HyperSchedule v4 raw -> canonical 5C Index Section.
 *
 * Frozen v1 decisions:
 * - ID:    "CSCI 051 PO-01 FA2026"  ({DEPT} {NUM:03d}{suffix} {SCHOOL}-{SEC:02d} {TERM})
 * - Term:  "FA2026" (HyperSchedule-native)
 * - Time:  startMin/endMin (int minutes, math) + startStr/endStr ("13:15", quote) + 12h display
 * - Status: raw O/C/R/U kept + label map; never inferred from seat arithmetic
 * - affiliation (identifier) and primaryAssociation (course) both preserved
 */

// ---------- schools ----------

const SCHOOL_NAMES: Record<string, string> = {
	PO: "Pomona College",
	CM: "Claremont McKenna College",
	HM: "Harvey Mudd College",
	SC: "Scripps College",
	PZ: "Pitzer College",
	CG: "Claremont Graduate University",
	KS: "Keck Science (joint)",
	JP: "Joint Program",
	JT: "Joint Taught",
	JM: "Joint Music",
	AF: "Intercollegiate (AF)",
	CH: "Intercollegiate (CH)",
	AA: "Intercollegiate (AA)",
	UN: "Unknown",
};

/** User-facing aliases -> canonical codes. Accepts names, aliases, codes, any case. */
const SCHOOL_ALIASES: Record<string, string> = {
	pomona: "PO",
	"pomona college": "PO",
	po: "PO",
	// Registrar data uses CM (not CMC) — all Claremont McKenna inputs map to CM.
	cm: "CM",
	cmc: "CM",
	"claremont mckenna": "CM",
	"claremont mckenna college": "CM",
	mckenna: "CM",
	"harvey mudd": "HM",
	"harvey mudd college": "HM",
	mudd: "HM",
	hmc: "HM",
	hm: "HM",
	scripps: "SC",
	"scripps college": "SC",
	sc: "SC",
	pitzer: "PZ",
	"pitzer college": "PZ",
	pz: "PZ",
	cgu: "CG",
	cg: "CG",
	keck: "KS",
	ks: "KS",
};

export function normalizeSchool(input: string): string {
	const key = input.trim().toLowerCase();
	if (SCHOOL_ALIASES[key]) return SCHOOL_ALIASES[key];
	// Joint / unknown affiliations pass through uppercased.
	return input.trim().toUpperCase();
}

export function schoolName(code: string): string {
	return SCHOOL_NAMES[code] ?? code;
}

export function isMainSchool(code: string): boolean {
	return ["PO", "CM", "HM", "SC", "PZ"].includes(code);
}

/**
 * Distinctive school alias words (length >= 3 to avoid po/sc/hm noise).
 * Used for "your query mentions a college" recall hints.
 */
const DISTINCTIVE_SCHOOL_WORDS: Record<string, string> = {
	mudd: "HM",
	hmc: "HM",
	pomona: "PO",
	pitzer: "PZ",
	scripps: "SC",
	mckenna: "CM",
	cmc: "CM",
	keck: "KS",
};

/** Return canonical school code when free text clearly names a college, else null. */
export function detectSchoolMention(text: string): string | null {
	const words = text
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter(Boolean);
	for (const w of words) {
		const hit = DISTINCTIVE_SCHOOL_WORDS[w];
		if (hit) return hit;
	}
	return null;
}

// ---------- time ----------

export function secToMin(sec: number): number {
	return Math.floor(sec / 60);
}

export function minToStr(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function minTo12(min: number): string {
	const h24 = Math.floor(min / 60);
	const m = min % 60;
	const suffix = h24 >= 12 ? "PM" : "AM";
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatMeeting(m: Meeting): string {
	const days = m.days.join("");
	const loc = m.locations.length > 0 ? ` @ ${m.locations[0]}` : "";
	return `${days} ${m.start12}–${m.end12}${loc}`;
}

// ---------- IDs ----------

/** "CSCI 051 PO-01 FA2026" */
export function sectionId(args: {
	dept: string;
	number: number;
	suffix: string;
	school: string;
	sectionNo: number;
	term: string;
}): string {
	const num = String(args.number).padStart(3, "0");
	const sec = String(args.sectionNo).padStart(2, "0");
	return `${args.dept.toUpperCase()} ${num}${args.suffix.toUpperCase()} ${args.school.toUpperCase()}-${sec} ${args.term.toUpperCase()}`;
}

/** "CSCI 051" — dept + zero-padded number + suffix, no school. */
export function courseCode(
	dept: string,
	number: number,
	suffix: string,
): string {
	return `${dept.toUpperCase()} ${String(number).padStart(3, "0")}${suffix.toUpperCase()}`;
}

export interface ParsedCode {
	dept?: string;
	number?: number;
	/** Raw digits as typed ("05" vs "5" carry different prefix semantics). */
	numberRaw?: string;
	suffix?: string;
	school?: string;
	sectionNo?: number;
	term?: string;
}

const CODE_RE =
	/^([A-Za-z]{2,4})?\s*(\d{1,3}[A-Za-z]?)?(?:\s*[- ]?\s*([A-Za-z]{2}))?(?:\s*[- ]?\s*0?(\d{1,2}))?\s*$/;
// NOTE: no leading `0*` before the number group — parseInt already strips
// leading zeros ("051"→51), and `0*` would swallow "000" entirely leaving the
// number group empty (breaking code-shaped detection for e.g. "QQQ 000").
const TERM_RE =
	/\b((?:FA|SP|SU)\s*\d{2,4}|(?:Fall|Spring|Summer)\s*\d{2,4}|\d{4}\s*(?:FA|SP|SU))\b/i;

/**
 * Parse loose user input into code parts. Never throws; returns what it found.
 * Handles: CSCI51, CSCI 51, CSCI051 PO-01, csci 51 po 1 FA2026, "CSCI 051 PO-01 FA2026".
 */
export function parseCode(input: string): ParsedCode {
	const out: ParsedCode = {};
	let rest = input.trim();
	const termMatch = rest.match(TERM_RE);
	if (termMatch) {
		const normalized = normalizeTerm(termMatch[1]);
		if (normalized) out.term = normalized;
		rest = rest.replace(termMatch[0], " ").trim();
	}
	const m = rest.match(CODE_RE);
	if (!m || (!m[1] && !m[2])) return out;
	if (m[1]) out.dept = m[1].toUpperCase();
	if (m[2]) {
		const numPart = m[2].match(/^(\d+)([A-Za-z]?)$/);
		if (numPart) {
			out.number = Number.parseInt(numPart[1], 10);
			out.numberRaw = numPart[1];
			if (numPart[2]) out.suffix = numPart[2].toUpperCase();
		}
	}
	if (m[3]) out.school = normalizeSchool(m[3]);
	if (m[4]) out.sectionNo = Number.parseInt(m[4], 10);
	return out;
}

/** FA26, Fall 2026, fall26, 2026FA, F26 -> FA2026. Returns null when unparseable. */
export function normalizeTerm(input: string): string | null {
	const t = input
		.trim()
		.toUpperCase()
		.replace(/[\s;_-]+/g, "");
	const seasonMap: Record<string, string> = {
		FA: "FA",
		F: "FA",
		FALL: "FA",
		SP: "SP",
		S: "SP",
		SPRING: "SP",
		P: "SP",
		SU: "SU",
		SUMMER: "SU",
		U: "SU",
	};
	// FA2026 | 2026FA — years are strictly 2 or 4 digits.
	let m = t.match(/^(FA|SP|SU|FALL|SPRING|SUMMER|F|S|P|U)(\d{2}|\d{4})$/);
	if (m) {
		const season = seasonMap[m[1]];
		const year = m[2].length === 2 ? `20${m[2]}` : m[2];
		return `${season}${year}`;
	}
	m = t.match(/^(\d{4})(FA|SP|SU|FALL|SPRING|SUMMER)$/);
	if (m) {
		const season =
			m[2] === "FALL"
				? "FA"
				: m[2] === "SPRING"
					? "SP"
					: m[2] === "SUMMER"
						? "SU"
						: m[2];
		return `${season}${m[1]}`;
	}
	// "2026;FA" Pomona CX form
	m = t.match(/^(\d{4})(FA|SP|SU)$/);
	if (m) return `${m[2]}${m[1]}`;
	return null;
}

/** "FA2026" -> "Fall 2026" */
export function termLabel(term: string): string {
	const m = term.match(/^(FA|SP|SU)(\d{4})$/);
	if (!m) return term;
	const season = m[1] === "FA" ? "Fall" : m[1] === "SP" ? "Spring" : "Summer";
	return `${season} ${m[2]}`;
}

// ---------- availability policy (single source of truth) ----------

/**
 * Registrar status is the only registrability signal: O (Open) and R
 * (Reopened) mean a student may register; C (Closed) means they may not,
 * regardless of computed capacity. Capacity (seats.available) is reported
 * everywhere but never equated with eligibility.
 */
export function isRegistrable(status: string): boolean {
	return status === "O" || status === "R";
}

// ---------- term ordering ----------

const SEASON_ORDER: Record<string, number> = { SP: 0, SU: 1, FA: 2 };

/** Calendar position of a term code: SP < SU < FA within a year. */
export function termRecency(term: string): number {
	const m = term.match(/^(FA|SP|SU)(\d{4})$/);
	if (!m) return Number.NaN;
	return Number(m[2]) * 10 + (SEASON_ORDER[m[1]] ?? 0);
}

/** Sort comparator: most recent term first (FA2026 > SU2026 > SP2026 > FA2025). */
export function compareTermRecencyDesc(a: string, b: string): number {
	const ra = termRecency(a);
	const rb = termRecency(b);
	if (Number.isNaN(ra) && Number.isNaN(rb)) return a.localeCompare(b);
	if (Number.isNaN(ra)) return 1;
	if (Number.isNaN(rb)) return -1;
	return rb - ra;
}

// ---------- days ----------

const DAY_ALIASES: Record<string, string> = {
	M: "M",
	MON: "M",
	T: "T",
	TU: "T",
	TUE: "T",
	W: "W",
	WED: "W",
	R: "R",
	TH: "R",
	THU: "R",
	F: "F",
	FRI: "F",
	S: "S",
	SA: "S",
	SAT: "S",
	U: "U",
	SU: "U",
	SUN: "U",
};

/**
 * Normalize day input to canonical letters. Accepts TR, T/R, TuTh, TueThu,
 * TTH, MWF, MW, daily, weekdays, weekends. TH = Thursday (5C convention).
 */
export function normalizeDays(input: string): string[] | null {
	const t = input.trim().toUpperCase();
	if (t === "DAILY" || t === "WEEKDAYS") return ["M", "T", "W", "R", "F"];
	if (t === "WEEKENDS") return ["S", "U"];
	if (t === "ANY") return [];
	const cleaned = t.replace(/[^A-Z]/g, " ");
	const tokens = cleaned.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (const tok of tokens) {
		// Try greedy 3/2/1-letter match (TUT/H vs T+H etc.)
		let rest = tok;
		const matched: string[] = [];
		let ok = true;
		while (rest.length > 0) {
			const three = DAY_ALIASES[rest.slice(0, 3)];
			const two = DAY_ALIASES[rest.slice(0, 2)];
			const one = DAY_ALIASES[rest.slice(0, 1)];
			if (
				three &&
				rest.length >= 3 &&
				["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].includes(
					rest.slice(0, 3),
				)
			) {
				matched.push(three);
				rest = rest.slice(3);
			} else if (
				two &&
				["TU", "TH", "SA", "SU", "MO", "WE", "FR"].includes(rest.slice(0, 2))
			) {
				matched.push(two);
				rest = rest.slice(2);
			} else if (one) {
				matched.push(one);
				rest = rest.slice(1);
			} else {
				ok = false;
				break;
			}
		}
		if (!ok) return null;
		out.push(...matched);
	}
	// Dedupe, canonical order MTWRFSU
	const order = ["M", "T", "W", "R", "F", "S", "U"];
	const unique = [...new Set(out)].sort(
		(a, b) => order.indexOf(a) - order.indexOf(b),
	);
	// Input with no day letters at all ("123", "") is a parse failure, not a
	// "no day constraint" filter — callers treat null as E_BAD_FILTER.
	return unique.length === 0 ? null : unique;
}

// ---------- times ----------

/** "10am", "10:00", "13:00", "1000", "10a", "after 1pm", "mornings" -> minutes. Null when unparseable. */
export function parseTime(input: string): number | null {
	let t = input.trim().toLowerCase();
	t = t.replace(/^(after|before|at|around)\s+/, "");
	if (t === "morning" || t === "mornings") return 8 * 60;
	if (t === "afternoon" || t === "afternoons") return 12 * 60;
	if (t === "evening" || t === "evenings" || t === "night") return 17 * 60;
	if (t === "noon") return 12 * 60;
	if (t === "midnight") return 0;
	const m = t.match(/^(\d{1,4})(?::(\d{2}))?\s*([ap])\.?m?\.?$/);
	if (m) {
		let h: number;
		let min = m[2] ? Number.parseInt(m[2], 10) : 0;
		if (m[1].length > 2 && !m[2]) {
			// "1000" -> 10:00
			h = Number.parseInt(m[1].slice(0, -2), 10);
			min = Number.parseInt(m[1].slice(-2), 10);
		} else {
			h = Number.parseInt(m[1], 10);
		}
		const ap = m[3];
		if (h < 1 || h > 12 || min > 59) return null;
		if (ap === "p" && h !== 12) h += 12;
		if (ap === "a" && h === 12) h = 0;
		return h * 60 + min;
	}
	const m24 = t.match(/^(\d{1,2})(?::(\d{2}))?$/);
	if (m24) {
		const h = Number.parseInt(m24[1], 10);
		const min = m24[2] ? Number.parseInt(m24[2], 10) : 0;
		if (h > 23 || min > 59) return null;
		return h * 60 + min;
	}
	const m4 = t.match(/^(\d{3,4})$/);
	if (m4) {
		const h = Number.parseInt(m4[1].slice(0, -2), 10);
		const min = Number.parseInt(m4[1].slice(-2), 10);
		if (h > 23 || min > 59) return null;
		return h * 60 + min;
	}
	return null;
}

// ---------- section normalization ----------

const STATUS_LABELS: Record<string, string> = {
	O: "Open",
	C: "Closed",
	R: "Reopened",
	U: "Unknown",
};

function toISO(d: { year: number; month: number; day: number }): string {
	// Upstream fallback is 1970-01-01 + potentialError=true; preserve as-is.
	const mm = String(d.month).padStart(2, "0");
	const dd = String(d.day).padStart(2, "0");
	return `${d.year}-${mm}-${dd}`;
}

const VALID_DAYS = new Set(["M", "T", "W", "R", "F", "S", "U"]);

export function normalizeSection(raw: RawSection): Section {
	const id = raw.identifier;
	const term = `${id.term}${id.year}`;
	const school = id.affiliation.toUpperCase();
	const status = ["O", "C", "R", "U"].includes(raw.status) ? raw.status : "U";

	const meetings: Meeting[] = [];
	let droppedMeetings = false;
	for (const s of raw.schedules.filter(
		(x) => !(x.startTime === 0 && x.endTime === 0 && x.days.length === 0),
	)) {
		const startMin = secToMin(s.startTime);
		const endMin = secToMin(s.endTime);
		// Cross-midnight guard: same-day meetings must satisfy [start, end).
		// Upstream never emits these today; conflicts.ts assumes the invariant.
		if (endMin <= startMin) {
			droppedMeetings = true;
			continue;
		}
		meetings.push({
			days: s.days.filter((d) => VALID_DAYS.has(d)) as Meeting["days"],
			startMin,
			endMin,
			startStr: minToStr(startMin),
			endStr: minToStr(endMin),
			start12: minTo12(startMin),
			end12: minTo12(endMin),
			locations: s.locations.map((l) => l.trim()).filter((l) => l.length > 0),
		});
	}

	const available = Math.max(0, raw.seatsTotal - raw.seatsFilled);

	return {
		id: sectionId({
			dept: id.department,
			number: id.courseNumber,
			suffix: id.suffix,
			school,
			sectionNo: id.sectionNumber,
			term,
		}),
		term,
		year: id.year,
		termCode: (["FA", "SP", "SU"].includes(id.term) ? id.term : "FA") as
			| "FA"
			| "SP"
			| "SU",
		half: id.half,
		dept: id.department.toUpperCase(),
		number: id.courseNumber,
		suffix: id.suffix.toUpperCase(),
		school,
		sectionNo: id.sectionNumber,
		code: courseCode(id.department, id.courseNumber, id.suffix),
		title: raw.course.title,
		description: raw.course.description,
		areas: raw.courseAreas,
		instructors: raw.instructors.map((i) => i.name.replace(/\s+/g, " ").trim()),
		meetings,
		credits: raw.credits,
		status: status as Section["status"],
		statusLabel: STATUS_LABELS[status] ?? "Unknown",
		seats: {
			filled: raw.seatsFilled,
			total: raw.seatsTotal,
			available,
			permCount: raw.permCount,
		},
		startDate: toISO(raw.startDate),
		endDate: toISO(raw.endDate),
		potentialError:
			raw.potentialError || raw.course.potentialError || droppedMeetings,
		primaryAssociation: raw.course.primaryAssociation,
		affiliation: school,
	};
}

export function normalizeTermSections(
	raw: RawSection[],
	term: string,
): Section[] {
	return raw.map(normalizeSection).filter((s) => s.term === term);
}
