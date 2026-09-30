/**
 * The MCP tool interface: input and output schemas for all five tools.
 *
 * Both live here on purpose. A tool's output schema is what a client reads to
 * learn the shape it will get, and the SDK validates every structured result
 * against it — so text and structured output cannot drift from the advertised
 * shape, and drift is caught in tests rather than in an agent's session.
 *
 * Inputs are `.strict()`: an unknown parameter is an error naming the key,
 * never a silently ignored typo.
 */
import { sectionSchema } from "5c-core";
import { z } from "zod";

// Registrar truth is CM (Claremont McKenna) + CG (Claremont Graduate).
// CMC is accepted here as an alias; core normalizes it to CM so it resolves
// to real hits.
export const SCHOOLS = [
	"PO",
	"CM",
	"CMC",
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
export const DAYS = ["M", "T", "W", "R", "F", "S", "U"] as const;
export const SORTS = ["relevance", "time", "seats", "code"] as const;

const fallbackSchema = z
	.object({
		requested: z.string(),
		served: z.string(),
	})
	.strict();

const termProvenanceSchema = z
	.object({
		term: z.string(),
		fetched_at: z.string(),
		stale: z.boolean(),
	})
	.strict();

/** Ingest counts travel with every result: partial ingest is never hidden. */
const ingestFields = {
	fetched_at: z.string().describe("When this process obtained the snapshot."),
	stale: z
		.boolean()
		.describe("Snapshot past the seat TTL; treat seats as indicative."),
	quarantined: z
		.number()
		.int()
		.describe("Rows dropped at ingest. Nonzero means incomplete coverage."),
	duplicate_ids: z
		.number()
		.int()
		.describe("Rows collapsed onto an existing canonical ID at ingest."),
};

// ---------- input schemas ----------

export const searchInputSchema = z
	.object({
		query: z
			.string()
			.optional()
			.describe(
				"Free text over title/description/code/instructor. Empty = browse with filters.",
			),
		term: z
			.string()
			.optional()
			.describe(
				"Term code, e.g. 'FA2026'. Defaults to current. Call list_terms if unsure.",
			),
		schools: z
			.array(z.enum(SCHOOLS))
			.optional()
			.describe(
				"Filter to colleges (5Cs + joint: KS JP JT JM AF CH AA; CG Claremont Graduate). CM is canonical for Claremont McKenna; CMC accepted as alias.",
			),
		departments: z
			.array(z.string())
			.optional()
			.describe("Dept codes, e.g. ['ECON','CSCI']. Case-insensitive."),
		code: z
			.string()
			.optional()
			.describe(
				"Course-code prefix. 'CSCI 051' matches that course; 'CSCI 05' matches the 050-059 family; 'CSCI' matches the department.",
			),
		days: z
			.array(z.enum(DAYS))
			.optional()
			.describe(
				"Must meet on ALL listed days, within the whole time window. R=Thursday.",
			),
		starts_after: z
			.string()
			.optional()
			.describe(
				"Earliest start 24h 'HH:MM', e.g. '13:00'. Applies to every meeting of a hit.",
			),
		ends_before: z
			.string()
			.optional()
			.describe(
				"Latest end 24h 'HH:MM'. An inverted window (start after end) is an error, not an empty result.",
			),
		instructor: z.string().optional().describe("Instructor name substring."),
		course_areas: z
			.array(z.string())
			.optional()
			.describe(
				"GE/area codes as the registrar writes them, e.g. ['QR']. Codes are per-college; a code from one campus does not apply at another.",
			),
		availability: z
			.enum(["any", "has_seat"])
			.default("any")
			.describe(
				"has_seat = registrar status says registrable (Open/Reopened). Computed capacity is reported, not used as eligibility.",
			),
		credits_min: z
			.number()
			.min(0)
			.max(99)
			.optional()
			.describe("Minimum credits; pairs with credits_max as a range."),
		credits_max: z
			.number()
			.min(0)
			.max(99)
			.optional()
			.describe("Maximum credits; pairs with credits_min as a range."),
		sort: z
			.enum(SORTS)
			.default("relevance")
			.describe(
				"Result order: relevance (default), time (earliest first), seats (most open first), code.",
			),
		explain: z
			.boolean()
			.default(false)
			.describe("Include multi-signal match explanations per hit."),
		exclude_conflicts_with: z
			.array(z.string())
			.optional()
			.describe(
				"Canonical section IDs in the searched term; overlapping hits are dropped. An unresolvable anchor is an error, never a silent no-op.",
			),
		allow_term_fallback: z
			.boolean()
			.default(false)
			.describe(
				"When the requested term is unpublished, serve the newest available term instead and say so. Default false: an unpublished term is an error naming the available terms.",
			),
		limit: z.number().int().min(1).max(50).default(10),
		offset: z.number().int().min(0).default(0),
	})
	.strict();

export const getInputSchema = z
	.object({
		ids: z
			.array(z.string())
			.min(1)
			.max(20)
			.describe("Canonical section IDs, e.g. 'CSCI 051 PO-01 FA2026'."),
		term: z.string().optional().describe("Term hint when IDs carry no term."),
		allow_term_fallback: z.boolean().default(false),
	})
	.strict();

export const checkInputSchema = z
	.object({
		ids: z
			.array(z.string())
			.min(1)
			.max(20)
			.describe(
				"Section IDs to audit together. Every ID must resolve exactly; unknown IDs fail the whole call.",
			),
		term: z.string().optional().describe("Term code, e.g. 'FA2026'."),
		passing_minutes: z
			.number()
			.int()
			.min(0)
			.max(60)
			.default(10)
			.describe("Minimum acceptable gap between consecutive classes."),
		allow_term_fallback: z.boolean().default(false),
	})
	.strict();

export const termsInputSchema = z
	.object({
		limit: z
			.number()
			.int()
			.min(1)
			.max(20)
			.default(6)
			.describe("Most recent N terms."),
	})
	.strict();

export const historyInputSchema = z
	.object({
		code: z
			.string()
			.describe("Course code without section, e.g. 'ECON 101', 'CSCI 151'."),
		schools: z
			.array(z.enum(SCHOOLS))
			.optional()
			.describe(
				"Filter to campuses. CM is canonical for Claremont McKenna; CMC accepted as alias.",
			),
		limit: z.number().int().min(1).max(12).default(6),
		term: z
			.string()
			.optional()
			.describe(
				"Term code anchoring instructor/seat enrichment, e.g. 'FA2026'. Defaults to current.",
			),
		allow_term_fallback: z.boolean().default(false),
	})
	.strict();

// ---------- output schemas ----------

const meetingBlockSchema = z
	.object({
		days: z.string().describe("Merged day letters for one meeting block."),
		start: z.string().describe("'HH:MM'"),
		end: z.string().describe("'HH:MM'"),
		location: z.string().nullable(),
	})
	.strict();

export const compactHitSchema = z
	.object({
		id: z.string(),
		term: z.string(),
		school: z.string(),
		code: z.string(),
		section: z.string(),
		title: z.string(),
		instructors: z.array(z.string()),
		days: z.string().describe('Merged across meetings; "" when TBA.'),
		start: z.string().nullable(),
		end: z.string().nullable(),
		meetings: z
			.array(meetingBlockSchema)
			.describe("Per-block truth; the summary above may combine blocks."),
		credits: z.number(),
		potential_error: z
			.boolean()
			.describe("Source data flagged unreliable; verify before relying on it."),
		seats_open: z.number(),
		seats_total: z.number(),
		status: z.string().describe("O=Open C=Closed R=Reopened U=unknown."),
		match: z.object({ score: z.number(), why: z.array(z.string()) }).strict(),
		fetched_at: z.string(),
		stale: z.boolean(),
	})
	.strict();

export const searchOutputSchema = z
	.object({
		term: z.string(),
		total_count: z.number(),
		has_more: z.boolean(),
		next_offset: z.number().nullable(),
		hits: z.array(compactHitSchema),
		hint: z.string().nullable(),
		suggestions: z.array(z.string()),
		snapshot_id: z
			.string()
			.nullable()
			.describe("Compare across pages: a change means the snapshot rotated."),
		applied_filters: z
			.record(z.string(), z.unknown())
			.describe("Filters as resolved, including the serving term."),
		seats_note: z.string(),
		...ingestFields,
		fallback: fallbackSchema.optional(),
		warning: z.string().optional(),
	})
	.strict();

export const getOutputSchema = z
	.object({
		classes: z.array(sectionSchema),
		not_found: z.array(z.string()),
		ambiguous: z
			.array(
				z
					.object({ input: z.string(), section_ids: z.array(z.string()) })
					.strict(),
			)
			.describe("Loose inputs matching several sections; ask the user which."),
		suggestions: z.array(
			z.object({ input: z.string(), ids: z.array(z.string()) }).strict(),
		),
		terms: z
			.array(termProvenanceSchema)
			.describe("One entry per snapshot used, in resolution order."),
		...ingestFields,
		fallback: fallbackSchema.optional(),
		warning: z.string().optional(),
	})
	.strict();

export const checkOutputSchema = z
	.object({
		ok: z.boolean().describe("No hard conflicts and no closed sections."),
		complete: z
			.boolean()
			.describe(
				"False when some inputs could not be fully audited (TBA times, flagged data). ok:true never implies a complete audit.",
			),
		skipped_tba: z
			.array(z.string())
			.describe("Sections with unknown meeting times; not conflict-checked."),
		total_credits: z.number(),
		class_count: z.number(),
		conflicts: z.array(
			z
				.object({
					a: z.string(),
					b: z.string(),
					days: z.array(z.string()),
					overlap: z.string(),
					overlap_minutes: z.number(),
					severity: z.enum(["hard", "tight"]),
				})
				.strict(),
		),
		travel_warnings: z.array(
			z
				.object({
					from: z.string(),
					to: z.string(),
					from_school: z.string(),
					to_school: z.string(),
					gap_minutes: z.number(),
					message: z.string(),
				})
				.strict(),
		),
		seat_problems: z.array(
			z.object({ id: z.string(), reason: z.string() }).strict(),
		),
		warnings: z.array(z.string()),
		weekly_grid: z.string(),
		checked: z.array(z.string()).describe("Section IDs that were audited."),
		terms: z.array(termProvenanceSchema),
		...ingestFields,
		fallback: fallbackSchema.optional(),
		warning: z.string().optional(),
	})
	.strict();

export const termsOutputSchema = z
	.object({
		current_term: z.string(),
		terms: z.array(
			z
				.object({
					code: z.string(),
					label: z.string(),
					year: z.number(),
					term: z.string(),
					is_current: z.boolean(),
				})
				.strict(),
		),
	})
	.strict();

export const historyOutputSchema = z
	.object({
		code: z.string(),
		offerings: z.array(
			z
				.object({
					term: z.string(),
					instructors: z.array(z.string()),
					campus: z.string(),
					seats: z
						.object({ capacity: z.number(), enrolled: z.number() })
						.strict()
						.nullable(),
				})
				.strict(),
		),
		rotation_note: z
			.string()
			.describe("Describes the window actually observed."),
		verdict: z.string(),
		fetched_at: z
			.string()
			.describe("Freshness of the offering-history source."),
		stale: z.boolean(),
		snapshot_term: z.string(),
		enrichment: z
			.object({
				term: z.string(),
				fetched_at: z.string(),
				stale: z.boolean(),
			})
			.strict()
			.nullable()
			.optional()
			.describe("Freshness of the sections snapshot used for seats."),
		fallback: fallbackSchema.optional(),
		warning: z.string().optional(),
	})
	.strict();

// ---------- payload types ----------
// What a handler returns: one object, rendered to text AND emitted as
// structuredContent. Text and structured data cannot describe different things.

export type SearchOutput = z.infer<typeof searchOutputSchema>;
export type GetOutput = z.infer<typeof getOutputSchema>;
export type CheckOutput = z.infer<typeof checkOutputSchema>;
export type TermsOutput = z.infer<typeof termsOutputSchema>;
export type HistoryOutput = z.infer<typeof historyOutputSchema>;
