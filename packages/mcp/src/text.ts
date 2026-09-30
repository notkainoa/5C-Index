/**
 * Text rendering for MCP tool results.
 *
 * Pure functions over the same payload the tool emits as structuredContent.
 * Many hosts show the text first (or only), so every warning an agent needs —
 * stale snapshot, partial ingest, incomplete audit, term fallback — has to be
 * in here, not just in the JSON.
 */
import type {
	CheckOutput,
	GetOutput,
	HistoryOutput,
	SearchOutput,
	TermsOutput,
} from "./schemas.js";

interface Provenance {
	fetched_at: string;
	stale: boolean;
	quarantined: number;
	duplicate_ids: number;
	fallback?: { requested: string; served: string };
	warning?: string;
}

/** Lines that must never be missing when provenance is imperfect. */
function provenanceLines(p: Provenance): string[] {
	const out: string[] = [];
	if (p.fallback) {
		out.push(
			`Note: term ${p.fallback.requested} is not published; showing ${p.fallback.served}.`,
		);
	} else if (p.warning) {
		out.push(`Note: ${p.warning}`);
	}
	const stale = p.stale ? " (STALE)" : "";
	out.push(
		`Seats as of ${p.fetched_at}${stale} — verify in CX before enrolling.`,
	);
	if (p.quarantined > 0) {
		out.push(
			`Coverage warning: ${p.quarantined} row(s) were dropped at ingest — results may be incomplete.`,
		);
	}
	if (p.duplicate_ids > 0) {
		out.push(
			`Coverage note: ${p.duplicate_ids} row(s) collapsed onto an existing ID at ingest (same dept/number/school/section).`,
		);
	}
	return out;
}

function moreLine(
	has_more: boolean,
	next_offset: number | null,
): string | null {
	if (!has_more || next_offset === null) return null;
	return `More results: call again with offset ${next_offset}.`;
}

export function searchText(p: SearchOutput): string {
	const lines: string[] = [];
	if (p.total_count === 0) {
		lines.push(`No matches in ${p.term}.`);
		lines.push(`Filters applied: ${JSON.stringify(p.applied_filters)}.`);
	} else {
		lines.push(
			`${p.total_count} match(es) in ${p.term} (showing ${p.hits.length}, as of ${p.fetched_at}).`,
		);
		for (const h of p.hits) {
			const seats = `${h.seats_open}/${h.seats_total} open`;
			const credits = h.credits > 0 ? `, ${h.credits} cr` : "";
			const flagged = h.potential_error ? " [source data flagged]" : "";
			lines.push(
				`- ${h.id} — ${h.title} [${h.status}${credits}, ${seats}]${flagged}`,
			);
			const meets =
				h.meetings.length > 0
					? h.meetings
							.map(
								(m) =>
									`${m.days || "TBA"} ${m.start}-${m.end}${m.location ? ` @ ${m.location}` : ""}`,
							)
							.join("; ")
					: "TBA (no scheduled meeting time)";
			lines.push(`  Meets: ${meets}`);
		}
	}
	if (p.hint) lines.push(p.hint);
	const more = moreLine(p.has_more, p.next_offset);
	if (more) lines.push(more);
	for (const s of p.suggestions) lines.push(`Suggestion: ${s}`);
	if (p.snapshot_id)
		lines.push(
			`Snapshot: ${p.snapshot_id} (same id across pages = same data).`,
		);
	lines.push(...provenanceLines(p));
	return lines.join("\n");
}

export function getText(p: GetOutput): string {
	const lines: string[] = [];
	for (const amb of p.ambiguous) {
		lines.push(
			`AMBIGUOUS: '${amb.input}' matches ${amb.section_ids.length} sections. Ask the user which, or pass a full ID: ${amb.section_ids.join(" | ")}`,
		);
	}
	if (p.not_found.length > 0) {
		const sug = p.suggestions
			.filter((s) => p.not_found.includes(s.input))
			.map((s) => `${s.input} → ${s.ids.join(", ")}`)
			.join("; ");
		lines.push(
			`NOT FOUND: ${p.not_found.join(", ")}.${sug ? ` Closest: ${sug}.` : ""} Search first, then pass IDs verbatim.`,
		);
	}
	for (const c of p.classes) {
		const meets =
			c.meetings.length > 0
				? c.meetings
						.map(
							(m) =>
								`${m.days.join("")} ${m.start12}–${m.end12} @ ${m.locations.join("; ") || "TBA"}`,
						)
						.join("\n  ")
				: "TBA";
		lines.push(
			`- ${c.id} — ${c.title} [${c.statusLabel}] ${c.credits} credit(s)`,
			`  Meets: ${meets}`,
			`  Seats: ${c.seats.available} open (${c.seats.filled}/${c.seats.total}; ${c.seats.permCount} instructor permits, not waitlist)`,
			`  Instructors: ${c.instructors.join(", ") || "staff TBD"}`,
			`  Areas: ${c.areas.join(", ") || "—"} | Dates: ${c.startDate} → ${c.endDate}`,
			`  ${c.description.split("\n")[0] ?? ""}`,
		);
		if (c.potentialError) {
			lines.push(`  Warning: source data for ${c.id} is flagged unreliable.`);
		}
		if (p.terms.length > 1) {
			const t = p.terms.find((x) => x.term === c.term);
			if (t?.stale) lines.push(`  Note: ${c.term} snapshot is stale.`);
		}
	}
	for (const t of p.terms) {
		lines.push(`${t.term}: as of ${t.fetched_at}${t.stale ? " (STALE)" : ""}`);
	}
	lines.push(...provenanceLines(p));
	return lines.join("\n");
}

export function checkText(p: CheckOutput): string {
	const lines: string[] = [];
	const completeness = p.complete
		? "audit complete"
		: `audit INCOMPLETE — ${p.skipped_tba.length} section(s) have unknown meeting times`;
	lines.push(
		p.ok
			? `OK: no hard conflicts and no closed sections (${p.class_count} classes, ${p.total_credits} credits; ${completeness}).`
			: `NOT OK (${p.class_count} classes, ${p.total_credits} credits; ${completeness}).`,
	);
	if (p.skipped_tba.length > 0) {
		lines.push(
			`Not checked (TBA times): ${p.skipped_tba.join(", ")}. TBA is absence of evidence, not evidence of a free slot.`,
		);
	}
	if (p.conflicts.length > 0) {
		lines.push(
			`Conflicts: ${p.conflicts
				.map(
					(c) =>
						`[${c.severity}] ${c.a} vs ${c.b} (${c.days.join("")} ${c.overlap})`,
				)
				.join("; ")}.`,
		);
	} else {
		lines.push("No time conflicts among the sections with known times.");
	}
	for (const t of p.travel_warnings) lines.push(`Travel: ${t.message}`);
	if (p.seat_problems.length > 0) {
		lines.push(
			`Seats: ${p.seat_problems.map((s) => `${s.id} — ${s.reason}`).join("; ")}.`,
		);
	}
	for (const w of p.warnings) lines.push(`Warning: ${w}`);
	lines.push(`Checked: ${p.checked.join(", ")}`);
	lines.push(...provenanceLines(p));
	return lines.join("\n");
}

export function termsText(p: TermsOutput): string {
	return `Current: ${p.current_term}. Terms: ${p.terms
		.map((t) => `${t.code} (${t.label})`)
		.join(", ")}.`;
}

export function historyText(p: HistoryOutput): string {
	const lines: string[] = [];
	lines.push(`${p.code}: ${p.verdict}`);
	lines.push(p.rotation_note);
	if (p.offerings.length === 0) {
		lines.push("No prior offerings found in the history source.");
	} else {
		for (const o of p.offerings) {
			const seats = o.seats
				? `${o.seats.enrolled}/${o.seats.capacity} enrolled`
				: "seats unknown";
			lines.push(
				`- ${o.term} @ ${o.campus} — ${o.instructors.join(", ") || "staff TBD"} (${seats})`,
			);
		}
	}
	lines.push(`History as of ${p.fetched_at}${p.stale ? " (STALE)" : ""}.`);
	if (p.enrichment) {
		lines.push(
			`Seats enriched from ${p.enrichment.term} snapshot as of ${p.enrichment.fetched_at}${p.enrichment.stale ? " (STALE)" : ""}.`,
		);
	}
	if (p.fallback) {
		lines.push(
			`Note: term ${p.fallback.requested} is not published; showing ${p.fallback.served}.`,
		);
	} else if (p.warning) {
		lines.push(`Note: ${p.warning}`);
	}
	return lines.join("\n");
}
