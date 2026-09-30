import type { Meeting, Section } from "./schema.js";

// Re-export schema types as the canonical type surface.
export type {
	CacheMeta,
	Day,
	RawHistoryEntry,
	RawSection,
	RawTerm,
	Status,
	Term,
} from "./schema.js";
export type { Meeting, Section };

export interface Filters {
	schools?: string[]; // canonical uppercase codes, e.g. ["PO","HM"]
	departments?: string[]; // uppercase, e.g. ["CSCI"]
	codePrefix?: string; // normalized "CSCI05" (dept + digits, no space)
	days?: string[]; // canonical day letters, must meet on ALL listed
	afterMin?: number; // meeting start >= (minutes since midnight)
	beforeMin?: number; // meeting end <=
	instructor?: string; // substring, case-insensitive
	areas?: string[]; // uppercase course-area codes
	creditsMin?: number;
	creditsMax?: number;
	openOnly?: boolean; // seats.available > 0
	excludeConflictIds?: string[]; // canonical section IDs to avoid overlapping
}

export interface RankedHit {
	section: Section;
	score: number;
	match: string[]; // machine-readable explanations
	fetched_at: string;
	stale: boolean;
}

export interface SearchResult {
	term: string;
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
	next_offset: number | null;
	hits: CompactHit[];
	hint: string | null;
	suggestions: string[];
	fetched_at: string;
	stale: boolean;
	/** Short snapshot identity; compare across pages to detect mid-page refreshes. */
	snapshot_id: string | null;
}

/** Compact hit: the ONLY shape search returns (~350 bytes). Full detail lives in get. */
export interface CompactHit {
	id: string;
	term: string;
	school: string;
	code: string;
	section: string; // "01"
	title: string;
	instructors: string[];
	/** Summary across meetings (merged days, earliest start, latest end). */
	days: string; // "TR" ("" when TBA)
	start: string | null; // "13:00" earliest (null when TBA)
	end: string | null;
	/** The actual meeting blocks — the summary above may combine them. */
	meetings: {
		days: string;
		start: string;
		end: string;
		location: string | null;
	}[];
	credits: number;
	potential_error: boolean;
	seats_open: number;
	seats_total: number;
	status: string;
	match: { score: number; why: string[] };
	fetched_at: string;
	stale: boolean;
}

export interface TermProvenance {
	term: string;
	fetched_at: string;
	stale: boolean;
}

/**
 * Snapshot provenance for a served result. `fetched_at` is when this process
 * obtained the snapshot, not when the registrar last updated it.
 *
 * `quarantined` and `duplicate_ids` are ingest counts for the snapshot(s)
 * used. Nonzero means the data behind a successful result is incomplete;
 * adapters surface them rather than hiding partial ingest.
 */
export interface SnapshotMeta {
	fetched_at: string;
	stale: boolean;
	quarantined: number;
	duplicate_ids: number;
}

/** A term fallback: requested term isn't published, served term shown instead. Opt-in only. */
export interface TermFallback {
	requested: string;
	served: string;
}

export interface GetResult {
	classes: Section[];
	/** Inputs that resolved to no section at all. */
	not_found: string[];
	/** Loose inputs that matched more than one section; caller must disambiguate. */
	ambiguous: { input: string; section_ids: string[] }[];
	/** Closest matches per not_found input (best-effort). */
	suggestions: { input: string; ids: string[] }[];
	/** Snapshot provenance per term actually loaded, in resolution order. */
	terms: TermProvenance[];
}

export interface ScheduleConflict {
	a: string;
	b: string;
	days: string[];
	overlap: string; // "10:30-10:50"
	overlap_minutes: number;
	severity: "hard" | "tight";
}

export interface TravelWarning {
	from: string;
	to: string;
	from_school: string;
	to_school: string;
	gap_minutes: number;
	message: string;
}

export interface CheckResult {
	ok: boolean;
	/** False when the audit could not see everything (TBA times, flagged data). */
	complete: boolean;
	/** Section IDs skipped because meeting times are unknown. */
	skipped_tba: string[];
	total_credits: number;
	class_count: number;
	conflicts: ScheduleConflict[];
	travel_warnings: TravelWarning[];
	seat_problems: { id: string; reason: string }[];
	warnings: string[];
	weekly_grid: string;
}

export interface TermInfo {
	code: string; // "FA2026"
	label: string; // "Fall 2026"
	year: number;
	term: string; // "FA"
	is_current: boolean;
}

export interface HistoryOffering {
	term: string;
	instructors: string[];
	campus: string;
	seats: { capacity: number; enrolled: number } | null;
}

export interface HistoryResult {
	code: string;
	offerings: HistoryOffering[];
	rotation_note: string;
	verdict: string;
	/** Freshness of the offering-history source itself. */
	fetched_at: string;
	stale: boolean;
	snapshot_term: string;
	/** Freshness of the sections snapshot used for enrichment, when one was used. */
	enrichment?: { term: string; fetched_at: string; stale: boolean } | null;
}
