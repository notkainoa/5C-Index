import { z } from "zod";

// ---------- HyperSchedule v4 raw schemas (banana.hyperschedule.io) ----------
// Source: shared/api/v4/course.ts @ hyperschedule/hyperschedule@v2
// Verified live 2026-09-25. Validate at ingest boundary once.

export const rawDateSchema = z.object({
	year: z.number(),
	month: z.number().min(1).max(12),
	day: z.number().min(1).max(31),
});

export const rawCourseCodeSchema = z.object({
	department: z.string(),
	courseNumber: z.number(),
	suffix: z.string(),
	affiliation: z.string(),
});

export const rawScheduleSchema = z.object({
	startTime: z.number(), // seconds since midnight
	endTime: z.number(),
	days: z.array(z.string()),
	locations: z.array(z.string()),
});

export const rawSectionSchema = z.object({
	courseAreas: z.array(z.string()),
	credits: z.number(),
	permCount: z.number().default(0),
	seatsTotal: z.number(),
	seatsFilled: z.number(),
	status: z.string(), // O | C | R | U (keep raw; map to labels downstream)
	startDate: rawDateSchema,
	endDate: rawDateSchema,
	instructors: z.array(z.object({ name: z.string() })),
	course: z.object({
		code: rawCourseCodeSchema,
		title: z.string(),
		description: z.string(),
		primaryAssociation: z.string(),
		potentialError: z.boolean().default(false),
	}),
	schedules: z.array(rawScheduleSchema),
	potentialError: z.boolean().default(false),
	identifier: z.object({
		department: z.string(),
		courseNumber: z.number(),
		suffix: z.string(),
		affiliation: z.string(),
		sectionNumber: z.number(),
		year: z.number(),
		term: z.string(), // FA | SP | SU
		half: z.nullable(z.object({ prefix: z.string(), number: z.number() })),
	}),
});

export type RawSection = z.infer<typeof rawSectionSchema>;
export const rawSectionsSchema = z.array(rawSectionSchema);

export const rawHistoryEntrySchema = z.object({
	code: rawCourseCodeSchema,
	terms: z.array(z.object({ year: z.number(), term: z.string() })),
});
export type RawHistoryEntry = z.infer<typeof rawHistoryEntrySchema>;
export const rawHistorySchema = z.array(rawHistoryEntrySchema);

export const rawTermSchema = z.object({ year: z.number(), term: z.string() });
export type RawTerm = z.infer<typeof rawTermSchema>;

export const rawCourseAreaSchema = z.object({
	area: z.string(),
	description: z.string(),
});

// ---------- Normalized 5C Index schemas ----------

export const termSchema = z
	.string()
	.regex(/^(FA|SP|SU)\d{4}$/, "Term must look like FA2026");
export type Term = z.infer<typeof termSchema>;

export const daySchema = z.enum(["M", "T", "W", "R", "F", "S", "U"]);
export type Day = z.infer<typeof daySchema>;

export const statusSchema = z.enum(["O", "C", "R", "U"]);
export type Status = z.infer<typeof statusSchema>;

export const meetingSchema = z.object({
	days: z.array(daySchema),
	startMin: z.number(), // minutes since midnight (math)
	endMin: z.number(),
	startStr: z.string(), // "13:15" (quote)
	endStr: z.string(),
	start12: z.string(), // "1:15 PM" (display)
	end12: z.string(),
	locations: z.array(z.string()),
});
export type Meeting = z.infer<typeof meetingSchema>;

export const sectionSchema = z.object({
	id: z.string(), // "CSCI 051 PO-01 FA2026" (canonical, frozen v1)
	term: termSchema,
	year: z.number(),
	termCode: z.enum(["FA", "SP", "SU"]),
	half: z.nullable(z.object({ prefix: z.string(), number: z.number() })),
	dept: z.string(),
	number: z.number(),
	suffix: z.string(),
	school: z.string(), // affiliation, uppercase (PO/CM/HM/SC/PZ + KS/JP/…)
	sectionNo: z.number(),
	code: z.string(), // "CSCI 051" (dept + zero-padded + suffix, no school)
	title: z.string(),
	description: z.string(),
	areas: z.array(z.string()),
	instructors: z.array(z.string()),
	meetings: z.array(meetingSchema),
	credits: z.number(),
	status: statusSchema,
	statusLabel: z.string(), // Open | Closed | Reopened | Unknown
	seats: z.object({
		filled: z.number(),
		total: z.number(),
		available: z.number(),
		permCount: z.number(),
	}),
	startDate: z.string(), // ISO
	endDate: z.string(),
	potentialError: z.boolean(),
	primaryAssociation: z.string(),
	affiliation: z.string(),
});
export type Section = z.infer<typeof sectionSchema>;

export const cacheMetaSchema = z.object({
	term: z.string(),
	fetched_at: z.string(),
	etag: z.string().nullable(),
	hash: z.string(),
	count: z.number(),
	source_url: z.string(),
	ttl_kind: z.string(),
	stale: z.boolean(),
	source: z.enum(["live", "stale-cache", "offline-file"]),
	quarantined: z.number().int().nonnegative().default(0),
	// Sections dropped because a later row produced the same canonical ID
	// (e.g. two half-semester rows collapsing onto one ID). Surfaced, never silent.
	duplicate_ids: z.number().int().nonnegative().optional(),
});
export type CacheMeta = z.infer<typeof cacheMetaSchema>;
