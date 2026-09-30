import {
	type Section,
	minTo12,
	minToStr,
	normalizeDays,
	parseTime,
} from "5c-core";

/**
 * Ad-hoc schedule blocks (`check --block "MWF 10:00-10:50"`).
 * Parsed and validated BEFORE any network access, then stamped with the
 * resolved term + date range so half-semester gating works against them.
 */

export interface BlockSpec {
	label: string;
	days: Section["meetings"][number]["days"];
	startMin: number;
	endMin: number;
}

export function parseBlock(block: string): BlockSpec {
	const m = block.trim().match(/^([A-Za-z/, ]+)\s+(\S+)\s*-\s*(\S+)$/);
	if (!m) {
		throw Object.assign(new Error(`Bad --block '${block}'.`), {
			code: "E_USAGE",
			hint: 'Format: --block "MWF 10:00-10:50".',
		});
	}
	const days = normalizeDays(m[1]);
	const start = parseTime(m[2]);
	const end = parseTime(m[3]);
	if (
		!days ||
		days.length === 0 ||
		start === null ||
		end === null ||
		end <= start
	) {
		throw Object.assign(new Error(`Bad --block '${block}'.`), {
			code: "E_USAGE",
			hint: 'Format: --block "MWF 10:00-10:50". Days like MWF/TR, times like 10:00am.',
		});
	}
	return {
		label: block.trim(),
		days: days as BlockSpec["days"],
		startMin: start,
		endMin: end,
	};
}

export function blockLabel(spec: BlockSpec): string {
	return `BLOCK ${spec.label}`;
}

/**
 * Build the synthetic Section conflict math consumes. Dates span the resolved
 * sections' range (so half-semester gating applies); seats are inert; school
 * is "BLOCK" (travel estimates are suppressed for blocks).
 */
export function blockToSection(
	spec: BlockSpec,
	term: string,
	dateRange: { start: string; end: string },
): Section {
	return {
		id: `BLOCK ${spec.label} ${term}`,
		term,
		year: Number.parseInt(term.slice(2), 10),
		termCode: term.slice(0, 2) as "FA" | "SP" | "SU",
		half: null,
		dept: "BLOCK",
		number: 0,
		suffix: "",
		school: "BLOCK",
		sectionNo: 0,
		code: "BLOCK",
		title: `Ad-hoc block ${spec.label}`,
		description: "",
		areas: [],
		instructors: [],
		meetings: [
			{
				days: spec.days,
				startMin: spec.startMin,
				endMin: spec.endMin,
				startStr: minToStr(spec.startMin),
				endStr: minToStr(spec.endMin),
				start12: minTo12(spec.startMin),
				end12: minTo12(spec.endMin),
				locations: [],
			},
		],
		credits: 0,
		status: "U",
		statusLabel: "Ad-hoc block",
		seats: { filled: 0, total: 0, available: 0, permCount: 0 },
		startDate: dateRange.start,
		endDate: dateRange.end,
		potentialError: false,
		primaryAssociation: "BLOCK",
		affiliation: "BLOCK",
	};
}
