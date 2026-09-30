import { isRegistrable, minToStr } from "./normalize.js";
import type { Meeting, Section } from "./schema.js";
import type { CheckResult, ScheduleConflict, TravelWarning } from "./types.js";

/**
 * Deterministic schedule math. The model must NEVER do time arithmetic —
 * all overlap / gap / credit logic lives here.
 */

// Approximate door-to-door minutes between campuses, measured informally
// on the Claremont campuses. Same campus = 0. Estimates only — actual
// buildings can be closer or farther; treat every travel number as "~".
const WALK: Record<string, Record<string, number>> = {
	PO: { PO: 0, SC: 5, CM: 8, HM: 10, PZ: 12 },
	SC: { PO: 5, SC: 0, CM: 5, HM: 8, PZ: 10 },
	CM: { PO: 8, SC: 5, CM: 0, HM: 6, PZ: 8 },
	HM: { PO: 10, SC: 8, CM: 6, HM: 0, PZ: 5 },
	PZ: { PO: 12, SC: 10, CM: 8, HM: 5, PZ: 0 },
};

function walkNeed(a: string, b: string): number {
	if (a === "BLOCK" || b === "BLOCK") return 0; // personal blocks: location is the user's own business
	return WALK[a]?.[b] ?? (a === b ? 0 : 10);
}

export function meetingsOverlap(a: Meeting, b: Meeting): boolean {
	// [start, end) — back-to-back (end == start) is NOT a conflict.
	if (!a.days.some((d) => b.days.includes(d))) return false;
	return a.startMin < b.endMin && b.startMin < a.endMin;
}

export function overlapMinutes(a: Meeting, b: Meeting): number {
	if (!a.days.some((d) => b.days.includes(d))) return 0;
	return Math.max(
		0,
		Math.min(a.endMin, b.endMin) - Math.max(a.startMin, b.startMin),
	);
}

function dateOverlap(a: Section, b: Section): boolean {
	// Full-semester sections within one term always overlap; half-semester
	// (or half vs full) only conflict when their date ranges intersect.
	if (!a.half && !b.half) return true;
	return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/** Two sections can't coexist: date ranges AND some meeting pair overlap. */
export function sectionsOverlap(a: Section, b: Section): boolean {
	if (!dateOverlap(a, b)) return false;
	for (const ma of a.meetings) {
		for (const mb of b.meetings) {
			if (meetingsOverlap(ma, mb)) return true;
		}
	}
	return false;
}

export function findConflicts(
	sections: Section[],
	passingMinutes = 10,
): { conflicts: ScheduleConflict[]; warnings: string[] } {
	const conflicts: ScheduleConflict[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		for (let j = i + 1; j < sections.length; j++) {
			const a = sections[i];
			const b = sections[j];
			if (a.meetings.length === 0 || b.meetings.length === 0) {
				warnings.push(
					`Time TBA for ${a.meetings.length === 0 ? a.id : b.id}; skipped in conflict check.`,
				);
				continue;
			}
			if (!dateOverlap(a, b)) continue;
			for (const ma of a.meetings) {
				for (const mb of b.meetings) {
					const common = ma.days.filter((d) => mb.days.includes(d));
					if (common.length === 0) continue;
					const ov = overlapMinutes(ma, mb);
					if (ov > 0) {
						const start = Math.max(ma.startMin, mb.startMin);
						const end = Math.min(ma.endMin, mb.endMin);
						conflicts.push({
							a: a.id,
							b: b.id,
							days: common,
							overlap: `${minToStr(start)}-${minToStr(end)}`,
							overlap_minutes: ov,
							severity: "hard",
						});
					} else {
						// Tight but non-overlapping: gap < passing threshold.
						const gap =
							mb.startMin >= ma.endMin
								? mb.startMin - ma.endMin
								: ma.startMin >= mb.endMin
									? ma.startMin - mb.endMin
									: 0;
						if (gap < passingMinutes) {
							conflicts.push({
								a: a.id,
								b: b.id,
								days: common,
								overlap: `gap ${gap}min (${minToStr(ma.startMin)}-${minToStr(ma.endMin)} vs ${minToStr(mb.startMin)}-${minToStr(mb.endMin)})`,
								overlap_minutes: 0,
								severity: "tight",
							});
						}
					}
				}
			}
		}
	}
	return { conflicts, warnings };
}

export function travelWarnings(
	sections: Section[],
	passingMinutes = 10,
): TravelWarning[] {
	const out: TravelWarning[] = [];
	// Per day, sort meetings across sections; check consecutive pairs.
	const days = ["M", "T", "W", "R", "F", "S", "U"];
	for (const day of days) {
		const blocks = sections.flatMap((s) =>
			s.meetings
				.filter((m) => m.days.includes(day as Meeting["days"][number]))
				.map((m) => ({ s, m })),
		);
		blocks.sort((x, y) => x.m.startMin - y.m.startMin);
		for (let i = 0; i + 1 < blocks.length; i++) {
			const prev = blocks[i];
			const next = blocks[i + 1];
			if (prev.s.id === next.s.id) continue;
			// Half-semester sections with disjoint dates never actually follow
			// each other; skip pairs whose date ranges don't intersect.
			if (!dateOverlap(prev.s, next.s)) continue;
			// Skip true overlaps (already reported as hard conflicts).
			if (prev.m.endMin > next.m.startMin) continue;
			const gap = next.m.startMin - prev.m.endMin;
			// Same known building = no campus transfer, whatever the affiliation says.
			const sameLoc =
				!!prev.m.locations[0] &&
				!!next.m.locations[0] &&
				prev.m.locations[0].toLowerCase() === next.m.locations[0].toLowerCase();
			const need = sameLoc ? 0 : walkNeed(prev.s.school, next.s.school);
			if (
				prev.s.school !== next.s.school &&
				!sameLoc &&
				(gap < need || gap <= passingMinutes)
			) {
				out.push({
					from: prev.s.id,
					to: next.s.id,
					from_school: prev.s.school,
					to_school: next.s.school,
					gap_minutes: gap,
					message:
						gap < need
							? `TIGHT: only ~${gap}min from ${prev.s.school} to ${next.s.school} on ${day} (${minToStr(prev.m.endMin)} → ${minToStr(next.m.startMin)}), needs ~${need}min.`
							: `Cross-campus ${prev.s.school}→${next.s.school} on ${day} with ~${gap}min gap.`,
				});
			}
		}
	}
	return out;
}

export function totalCredits(sections: Section[]): number {
	return (
		Math.round(sections.reduce((sum, s) => sum + s.credits, 0) * 100) / 100
	);
}

export function weeklyGrid(sections: Section[]): string {
	const days = ["M", "T", "W", "R", "F", "S", "U"] as const;
	const lines: string[] = [];
	for (const day of days) {
		const blocks = sections.flatMap((s) =>
			s.meetings.filter((m) => m.days.includes(day)).map((m) => ({ s, m })),
		);
		blocks.sort((a, b) => a.m.startMin - b.m.startMin);
		if (blocks.length === 0) {
			lines.push(`${day}: —`);
			continue;
		}
		const cells = blocks
			.map(
				(b) =>
					`${minToStr(b.m.startMin)}-${minToStr(b.m.endMin)} ${b.s.code} (${b.s.school})`,
			)
			.join(" | ");
		lines.push(`${day}: ${cells}`);
	}
	return lines.join("\n");
}

export function checkSchedule(
	sections: Section[],
	opts: { passingMinutes?: number } = {},
): CheckResult {
	const passing = opts.passingMinutes ?? 10;
	const { conflicts, warnings } = findConflicts(sections, passing);
	const travel = travelWarnings(sections, passing);
	const seat_problems = sections
		.filter((s) => s.school !== "BLOCK") // ad-hoc blocks carry no seat data
		.filter((s) => !isRegistrable(s.status) || s.seats.available <= 0)
		.map((s) => ({
			id: s.id,
			reason: !isRegistrable(s.status)
				? `Closed by registrar (status ${s.status}; cap ${s.seats.total}, filled ${s.seats.filled})`
				: `No remaining capacity (status ${s.status}; filled ${s.seats.filled}/${s.seats.total})`,
		}));
	const skipped_tba = sections
		.filter((s) => s.meetings.length === 0)
		.map((s) => s.id);
	for (const s of sections) {
		if (s.potentialError) {
			warnings.push(
				`${s.id}: source data flagged potential_error; treat its times as unreliable.`,
			);
		}
	}
	// Credits are raw sums: units differ across the 5Cs (HM 3–4 vs PO/PZ 1)
	// and registrar conversion rules are unverified, so no load advice.
	const hard = conflicts.filter((c) => c.severity === "hard");
	return {
		ok: hard.length === 0 && seat_problems.length === 0,
		complete:
			skipped_tba.length === 0 && sections.every((s) => !s.potentialError),
		skipped_tba,
		total_credits: totalCredits(sections),
		class_count: sections.length,
		conflicts,
		travel_warnings: travel,
		seat_problems,
		warnings,
		weekly_grid: weeklyGrid(sections),
	};
}
