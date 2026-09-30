/**
 * 5c — agent-first CLI for 5C course search.
 * Thin over 5c-core: parsing transport input and rendering. Policy and
 * validation live in core (see plan.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	cacheDir,
	checkSchedule,
	checkScheduleByIds,
	defaultTerm,
	getClasses,
	getCourseHistory,
	listTerms,
	normalizeSchool,
	normalizeTerm,
	peekTermMeta,
	readCurrentTermFile,
	refreshTerm,
	searchClasses,
} from "5c-core";
import type { Section } from "5c-core";
import { Command, type CommanderError } from "commander";
import { blockLabel, blockToSection, parseBlock } from "./blocks.js";
import {
	CODE_HINT,
	FILE_IDS_HINT,
	type GlobalOpts,
	KNOWN_HIT_FIELDS,
	SCHEMA_VERSION,
	TERMS_HINT,
	cliVersion,
	collectKnownFlags,
	emitCoreError,
	emitError,
	emitJson,
	guardFlagSwallow,
	ingestWarnings,
	parseIntStrict,
	pickFields,
	requireValidFormat,
	splitList,
	wantJson,
} from "./envelope.js";
import { table } from "./render.js";

const VERSION = cliVersion();

/**
 * Core attaches `warning` (alongside `fallback: {requested, served}`) when it
 * served a different term. The warning text names both terms, so it is all the
 * human/JSON envelope needs.
 */
function fallbackWarning(ret: { warning?: string }): string | null {
	return ret.warning ?? null;
}

function staleWarning(stale: boolean): string | null {
	return stale
		? "snapshot is stale; seats may have changed — run `5c refresh` for fresh numbers"
		: null;
}

/** Only claim a last-good snapshot when one is actually cached. */
function hasSnapshot(term: string): boolean {
	try {
		return existsSync(join(cacheDir(), `${term.toUpperCase()}.json`));
	} catch {
		return false;
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** Parse a --file/--stdin payload into section IDs, or exit 2 E_USAGE. */
function asIdList(
	raw: unknown,
	where: string,
	globals: GlobalOpts,
	command: string,
): string[] {
	if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
		return raw as string[];
	}
	if (
		raw !== null &&
		typeof raw === "object" &&
		Array.isArray((raw as { sections: unknown }).sections) &&
		((raw as { sections: unknown[] }).sections as unknown[]).every(
			(x) => typeof x === "string",
		)
	) {
		return (raw as { sections: string[] }).sections;
	}
	emitError(
		command,
		"E_USAGE",
		`Bad ID list in ${where}: expected an array of IDs or {"sections":[...]}.`,
		FILE_IDS_HINT,
		{},
		globals,
		2,
	);
}

// ---------- commands ----------

const program = new Command();
program
	.name("5c")
	.description(
		"Search Claremont Colleges (5C) courses. Data: HyperSchedule v4 (cached). Seats as of fetched_at — verify in CX before enrolling.",
	)
	.option("--json", "machine-readable JSON output")
	.option("--format <fmt>", "json|table")
	.option("--no-color", "disable colors")
	.option("--non-interactive", "never prompt (default: never prompts)")
	.version(VERSION, "-V, --version");
// Commander failures must use the JSON envelope + exit 2, never plain text.
program.exitOverride();
program.configureOutput({ writeErr: () => {} });

program
	.command("search [query]")
	.description(
		"Filtered, ranked course search (one call answers 80% of questions). ST column: O=open C=closed R=reopened U=unknown.",
	)
	.option(
		"--school <s...>",
		"school codes or names, e.g. PO, CM, 'Claremont McKenna' (repeatable, comma-ok)",
	)
	.option("--dept <d...>", "department codes, e.g. CSCI MATH (repeatable)")
	.option(
		"--code <c>",
		"course-code prefix: 'CSCI 051' exact course, 'CSCI 05' the 050 family, CSCI the department",
	)
	.option(
		"--days <d>",
		"e.g. TR, MWF, T/R, TuTh (R=Thursday); must meet on ALL listed days",
	)
	.option(
		"--after <t>",
		"earliest start; EVERY meeting must start at/after, e.g. 1pm, 13:00, 10:00am",
	)
	.option(
		"--before <t>",
		"latest end; EVERY meeting must end at/before, e.g. 5pm, 17:00",
	)
	.option(
		"--open",
		"only sections the registrar lists as open/reopened (status O/R)",
	)
	.option("--instructor <n>", "instructor name substring, e.g. Dodds")
	.option("--area <a...>", "course-area codes, e.g. HIST CSCI (repeatable)")
	.option("--credits <c>", "credits, e.g. 1 or 0.5-1")
	.option(
		"--term <t>",
		"canonical term, e.g. FA2026 (default: current). Unpublished terms exit 2 listing available terms.",
	)
	.option(
		"--fallback-term",
		"if the requested term isn't published, serve the newest available term instead (warns)",
	)
	.option(
		"--exclude-conflicts-with <ids...>",
		"exclude sections overlapping these canonical IDs, e.g. 'CSCI 005 HM-01 FA2026'",
	)
	.option("--limit <n>", "max hits (default 10, max 50)", "10")
	.option("--offset <n>", "pagination offset", "0")
	.option("--sort <s>", "relevance|time|seats|code", "relevance")
	.option(
		"--explain",
		"include match explanations (no-op in browse mode: empty query)",
	)
	.option("--fields <f>", "comma list, e.g. id,title,seats_open")
	.action(
		async (query: string | undefined, cmdOpts: Record<string, unknown>) => {
			const globals = program.opts<GlobalOpts>();
			try {
				requireValidFormat(globals, "search");
				const limit = parseIntStrict(cmdOpts.limit);
				if (limit === null || limit < 1 || limit > 50) {
					emitError(
						"search",
						"E_USAGE",
						`Bad --limit '${cmdOpts.limit}'.`,
						"Use --limit 1..50.",
						{},
						globals,
						2,
					);
				}
				const offset = parseIntStrict(cmdOpts.offset);
				if (offset === null || offset < 0) {
					emitError(
						"search",
						"E_USAGE",
						`Bad --offset '${cmdOpts.offset}'.`,
						"Use --offset >= 0.",
						{},
						globals,
						2,
					);
				}
				const sort = String(cmdOpts.sort);
				if (!["relevance", "time", "seats", "code"].includes(sort)) {
					emitError(
						"search",
						"E_USAGE",
						`Bad --sort '${sort}'.`,
						"Valid: relevance|time|seats|code.",
						{},
						globals,
						2,
					);
				}
				const { result, normalized, meta, ...rest } = await searchClasses(
					query ?? "",
					{
						term: cmdOpts.term as string | undefined,
						schools: splitList(cmdOpts.school as string[] | undefined),
						depts: splitList(cmdOpts.dept as string[] | undefined),
						code: cmdOpts.code as string | undefined,
						days: cmdOpts.days as string | undefined,
						after: cmdOpts.after as string | undefined,
						before: cmdOpts.before as string | undefined,
						instructor: cmdOpts.instructor as string | undefined,
						areas: splitList(cmdOpts.area as string[] | undefined),
						credits: cmdOpts.credits as string | undefined,
						open: cmdOpts.open as boolean | undefined,
						excludeConflictsWith: splitList(
							cmdOpts.excludeConflictsWith as string[] | undefined,
						),
						limit,
						offset,
						sort: sort as "relevance" | "time" | "seats" | "code",
						explain: Boolean(cmdOpts.explain),
						allowTermFallback: Boolean(cmdOpts.fallbackTerm),
					},
				);
				const warnings: string[] = [];
				const fb = fallbackWarning(rest);
				if (fb) warnings.push(fb);
				const stale = staleWarning(meta.stale);
				if (stale) warnings.push(stale);
				warnings.push(...ingestWarnings(meta));
				let hits: unknown[] = result.hits;
				if (cmdOpts.fields) {
					const fields = String(cmdOpts.fields)
						.split(",")
						.map((f) => f.trim())
						.filter(Boolean);
					const unknownFields = fields.filter((f) => !KNOWN_HIT_FIELDS.has(f));
					if (unknownFields.length > 0) {
						warnings.push(
							`unknown --fields ignored: ${unknownFields.join(", ")} (valid: ${[...KNOWN_HIT_FIELDS].join(",")})`,
						);
					}
					hits = result.hits.map((h) =>
						pickFields(h as unknown as Record<string, unknown>, fields),
					);
				}
				if (wantJson(globals)) {
					emitJson({
						ok: true,
						command: "search",
						data: { ...result, hits },
						meta: {
							version: VERSION,
							schema_version: SCHEMA_VERSION,
							...meta,
							normalized,
						},
						next: result.hits[0] ? [`5c get "${result.hits[0].id}"`] : [],
						warnings,
					});
				} else {
					for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
					if (result.hits.length === 0) {
						if (result.hint) process.stderr.write(`${result.hint}\n`);
						for (const s of result.suggestions)
							process.stderr.write(`suggestion: ${s}\n`);
						return;
					}
					const rows = [
						["ID", "TITLE", "MTG", "SEATS", "ST"],
						...result.hits.map((h) => [
							h.id,
							h.title.slice(0, 44),
							`${h.days || "TBA"} ${h.start ?? "?"}-${h.end ?? "?"}`,
							`${h.seats_open}/${h.seats_total}`,
							h.status,
						]),
					];
					process.stdout.write(`${table(rows)}\n`);
					process.stderr.write(
						`${result.total} hits (term ${result.term}, seats as of ${result.fetched_at}${meta.stale ? ", STALE" : ""}).\nST: O=open C=closed R=reopened U=unknown.\n`,
					);
					if (result.hint) process.stderr.write(`hint: ${result.hint}\n`);
					for (const s of result.suggestions)
						process.stderr.write(`suggestion: ${s}\n`);
				}
			} catch (err) {
				emitCoreError("search", err, globals);
			}
		},
	);

program
	.command("get <id>")
	.description(
		"Full detail for one section. Bare codes resolve only when unique; ambiguous codes list candidates (exit 3).",
	)
	.option("--term <t>", "term hint when ID has no term, e.g. FA2026")
	.option(
		"--fallback-term",
		"if the requested term isn't published, serve the newest available term instead (warns)",
	)
	.action(async (id: string, cmdOpts: Record<string, unknown>) => {
		const globals = program.opts<GlobalOpts>();
		try {
			requireValidFormat(globals, "get");
			const { result, meta, ...rest } = await getClasses([id], {
				term: cmdOpts.term as string | undefined,
				allowTermFallback: Boolean(cmdOpts.fallbackTerm),
			});
			const warnings: string[] = [];
			const fb = fallbackWarning(rest);
			if (fb) warnings.push(fb);
			const stale = staleWarning(meta.stale);
			if (stale) warnings.push(stale);
			warnings.push(...ingestWarnings(meta));
			const trimmed = id.trim();
			if (result.ambiguous.length > 0) {
				const amb = result.ambiguous[0];
				emitError(
					"get",
					"E_NOT_FOUND",
					`Ambiguous '${trimmed}': ${amb.section_ids.length} sections match.`,
					`Pass a full ID: ${amb.section_ids.join(" | ")}`,
					{ did_you_mean: amb.section_ids },
					globals,
					3,
				);
			}
			const exact = result.classes.find(
				(c) => c.id.toLowerCase() === trimmed.toLowerCase(),
			);
			const cls = exact ?? result.classes[0];
			if (!cls) {
				const sug = result.suggestions.find((s) => s.input === id)?.ids ?? [];
				emitError(
					"get",
					"E_NOT_FOUND",
					`Unknown section '${trimmed}'.`,
					"Search first, then pass IDs verbatim.",
					{ did_you_mean: sug },
					globals,
					3,
				);
			}
			if (!exact && cls) {
				warnings.push(
					`resolved '${trimmed}' to ${cls.id}; pass the full ID to pin the section`,
				);
			}
			if (cls.potentialError === true) {
				warnings.push("potential_error: source data may be unreliable");
			}
			if (wantJson(globals)) {
				emitJson({
					ok: true,
					command: "get",
					data: cls,
					meta: { version: VERSION, schema_version: SCHEMA_VERSION, ...meta },
					next: [],
					warnings,
				});
			} else {
				for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
				const c = cls;
				process.stdout.write(
					`${c.id}\n${c.title} — ${c.credits} credit(s) [${c.statusLabel}]\n` +
						`Instructors: ${c.instructors.join(", ") || "TBA"}\n` +
						`Meetings:\n${c.meetings.map((m) => `  ${m.days.join("")} ${m.start12}–${m.end12} @ ${m.locations.join("; ") || "TBA"}`).join("\n") || "  TBA"}\n` +
						`Seats: ${c.seats.available} open (${c.seats.filled}/${c.seats.total}, perms ${c.seats.permCount} = instructor permits, not waitlist)\n` +
						`Areas: ${c.areas.join(", ") || "—"}\n` +
						`${c.description}\n`,
				);
				process.stderr.write(
					`Seats as of ${meta.fetched_at}${meta.stale ? " (STALE)" : ""} — verify in CX before enrolling.\n`,
				);
			}
		} catch (err) {
			emitCoreError("get", err, globals);
		}
	});

program
	.command("check [ids...]")
	.description(
		"Audit sections for conflicts/travel/credits/seats. ok:false + exit 0 means the audit ran and the schedule is invalid. complete:false means some sections could not be fully checked (TBA times, flagged data).",
	)
	.option("--against <ids...>", "additional IDs to check against")
	.option("--block <b...>", 'ad-hoc blocks, e.g. --block "MWF 10:00-10:50"')
	.option(
		"--file <f>",
		'JSON file: ["ID1","ID2"] or {"sections":["ID1","ID2"]}',
	)
	.option(
		"--stdin",
		'read IDs from stdin as JSON: ["ID1","ID2"] or {"sections":[...]}',
	)
	.option("--term <t>", "term hint, e.g. FA2026")
	.option(
		"--fallback-term",
		"if the requested term isn't published, serve the newest available term instead (warns)",
	)
	.option(
		"--passing-minutes <n>",
		"min acceptable gap, integer >= 0 (default 10)",
		"10",
	)
	.action(async (ids: string[], cmdOpts: Record<string, unknown>) => {
		const globals = program.opts<GlobalOpts>();
		try {
			requireValidFormat(globals, "check");
			// Blocks parse + validate BEFORE any fetch: bad blocks exit 2 offline.
			const blockSpecs = splitList(cmdOpts.block as string[] | undefined).map(
				parseBlock,
			);
			const allIds = [
				...(ids ?? []),
				...splitList(cmdOpts.against as string[] | undefined),
			];
			if (cmdOpts.file) {
				const p = String(cmdOpts.file);
				let text: string;
				try {
					text = readFileSync(p, "utf8") as string;
				} catch {
					emitError(
						"check",
						"E_USAGE",
						`Cannot read file '${p}'.`,
						FILE_IDS_HINT,
						{},
						globals,
						2,
					);
				}
				let raw: unknown;
				try {
					raw = JSON.parse(text);
				} catch {
					emitError(
						"check",
						"E_USAGE",
						`Bad JSON in file '${p}'.`,
						FILE_IDS_HINT,
						{},
						globals,
						2,
					);
				}
				allIds.push(...asIdList(raw, `file '${p}'`, globals, "check"));
			}
			if (cmdOpts.stdin) {
				let text: string;
				try {
					text = await readStdin();
				} catch {
					emitError(
						"check",
						"E_USAGE",
						"Cannot read stdin.",
						FILE_IDS_HINT,
						{},
						globals,
						2,
					);
				}
				let raw: unknown;
				try {
					raw = JSON.parse(text);
				} catch {
					emitError(
						"check",
						"E_USAGE",
						"Bad JSON on stdin.",
						FILE_IDS_HINT,
						{},
						globals,
						2,
					);
				}
				allIds.push(...asIdList(raw, "stdin", globals, "check"));
			}
			if (allIds.length === 0) {
				emitError(
					"check",
					"E_USAGE",
					"check needs at least one section ID (--block augments a schedule, it doesn't replace one).",
					'Example: 5c check "CSCI 051 PO-01 FA2026" "MATH 031 PO-02 FA2026"',
					{},
					globals,
					2,
				);
			}
			// One ID is a valid audit (seats + completeness); two or more is
			// where conflicts become possible.
			const passing = parseIntStrict(cmdOpts.passingMinutes);
			if (passing === null) {
				emitError(
					"check",
					"E_USAGE",
					`Bad --passing-minutes '${cmdOpts.passingMinutes}'.`,
					"Use an integer >= 0 (default 10).",
					{},
					globals,
					2,
				);
			}
			const {
				result,
				sections: resolvedSections,
				resolved,
				meta,
				...rest
			} = await checkScheduleByIds(allIds, {
				term: cmdOpts.term as string | undefined,
				passingMinutes: passing ?? undefined,
				allowTermFallback: Boolean(cmdOpts.fallbackTerm),
			});
			let final = result;
			let checkedExtra: string[] = [];
			if (blockSpecs.length > 0) {
				const term0 = resolvedSections[0]?.term ?? "FA2026";
				const range =
					resolvedSections.length > 0
						? {
								start: resolvedSections.reduce(
									(m, s) => (s.startDate < m ? s.startDate : m),
									resolvedSections[0].startDate,
								),
								end: resolvedSections.reduce(
									(m, s) => (s.endDate > m ? s.endDate : m),
									resolvedSections[0].endDate,
								),
							}
						: { start: "1970-01-01", end: "1970-01-01" };
				final = checkSchedule(
					[
						...resolvedSections,
						...blockSpecs.map((b) => blockToSection(b, term0, range)),
					],
					{ passingMinutes: passing ?? undefined },
				);
				checkedExtra = blockSpecs.map(blockLabel);
			}
			const fb = fallbackWarning(rest);
			const stale = staleWarning(meta.stale);
			const allWarnings = [
				...(fb ? [fb] : []),
				...(stale ? [stale] : []),
				...ingestWarnings(meta),
				...final.warnings,
			];
			if (wantJson(globals)) {
				emitJson({
					ok: true,
					command: "check",
					data: {
						...final,
						checked: [...resolved, ...checkedExtra],
					},
					meta: { version: VERSION, schema_version: SCHEMA_VERSION, ...meta },
					next: [],
					warnings: allWarnings,
				});
			} else {
				for (const w of allWarnings) process.stderr.write(`warning: ${w}\n`);
				const conflictLines = final.conflicts
					.map(
						(c) =>
							`  [${c.severity}] ${c.a} vs ${c.b} (${c.days.join("")} ${c.overlap})`,
					)
					.join("\n");
				const travelLines = final.travel_warnings
					.map((t) => `  ${t.message}`)
					.join("\n");
				const seatLines = final.seat_problems
					.map((s) => `  ${s.id}: ${s.reason}`)
					.join("\n");
				const verdict = final.ok ? "OK" : "CONFLICT";
				const completePart = final.complete
					? ""
					: `\nINCOMPLETE: could not fully check ${final.skipped_tba.join(", ") || "flagged sections"} (TBA/flagged data).`;
				const conflictPart =
					final.conflicts.length > 0
						? `Conflicts:\n${conflictLines}\n`
						: "No time conflicts.\n";
				const travelPart =
					final.travel_warnings.length > 0 ? `Travel:\n${travelLines}\n` : "";
				const seatPart =
					final.seat_problems.length > 0 ? `Seats:\n${seatLines}\n` : "";
				process.stdout.write(
					`${verdict} — ${final.class_count} classes, ${final.total_credits} credits (raw sum; units differ across colleges)\n${conflictPart}${travelPart}${seatPart}Weekly:\n${final.weekly_grid}\n${completePart}\n`,
				);
			}
		} catch (err) {
			emitCoreError("check", err, globals);
		}
	});

program
	.command("terms")
	.description("List known terms + current/default + fetched data")
	.option("--limit <n>", "most recent N terms", "6")
	.action(async (cmdOpts: Record<string, unknown>) => {
		const globals = program.opts<GlobalOpts>();
		try {
			requireValidFormat(globals, "terms");
			const limit = parseIntStrict(cmdOpts.limit) ?? 6;
			const { current, available } = await listTerms({ limit });
			if (wantJson(globals)) {
				emitJson({
					ok: true,
					command: "terms",
					data: { current, terms: available },
					meta: { version: VERSION, schema_version: SCHEMA_VERSION },
					next: [`5c search --term ${current} --limit 5`],
					warnings: [],
				});
			} else {
				const grid = table([
					["TERM", "LABEL", "CURRENT"],
					...available.map((t) => [t.code, t.label, t.is_current ? "*" : ""]),
				]);
				process.stdout.write(`${grid}\n`);
			}
		} catch (err) {
			emitCoreError("terms", err, globals);
		}
	});

program
	.command("history <code>")
	.description(
		"Prior offerings of a course across terms (rotation signal, observed window)",
	)
	.option("--campus <c...>", "filter campuses, e.g. PO HM")
	.option("--school <c...>", "alias for --campus, e.g. PO HM")
	.option("--limit <n>", "max offerings", "6")
	.option("--term <t>", "snapshot term for instructor/seat enrichment")
	.option(
		"--fallback-term",
		"if the requested term isn't published, serve the newest available term instead (warns)",
	)
	.action(async (code: string, cmdOpts: Record<string, unknown>) => {
		const globals = program.opts<GlobalOpts>();
		try {
			requireValidFormat(globals, "history");
			const h = await getCourseHistory(code, {
				campuses: [
					...splitList(cmdOpts.campus as string[] | undefined),
					...splitList(cmdOpts.school as string[] | undefined),
				].map((c) => normalizeSchool(c)),
				limit: parseIntStrict(cmdOpts.limit) ?? 6,
				term: cmdOpts.term as string | undefined,
				allowTermFallback: Boolean(cmdOpts.fallbackTerm),
			});
			if (wantJson(globals)) {
				emitJson({
					ok: true,
					command: "history",
					data: h,
					meta: { version: VERSION, schema_version: SCHEMA_VERSION },
					next: [],
					warnings:
						typeof h.warning === "string" && h.warning
							? [h.warning as string]
							: [],
				});
			} else {
				if (typeof h.warning === "string" && h.warning) {
					process.stderr.write(`warning: ${h.warning}\n`);
				}
				if (h.offerings.length === 0) {
					process.stderr.write(`${h.rotation_note}\n`);
					return;
				}
				const grid = table([
					["TERM", "CAMPUS", "SEATS", "INSTRUCTORS"],
					...h.offerings.map((o) => [
						o.term,
						o.campus,
						o.seats ? `${o.seats.capacity}/${o.seats.enrolled}` : "—",
						o.instructors.join(", ") || "—",
					]),
				]);
				process.stdout.write(
					`${h.code}: ${h.verdict}\n${h.rotation_note}\n${grid}\nSEATS: cap/enrolled.\n`,
				);
			}
		} catch (err) {
			emitCoreError("history", err, globals);
		}
	});

program
	.command("refresh")
	.description(
		"Force a fresh snapshot pull from HyperSchedule (seats go stale fast in add/drop)",
	)
	.option("--term <t>", "term to refresh (default: current)")
	.option("--force", "bypass ETag revalidation")
	.action(async (cmdOpts: Record<string, unknown>) => {
		const globals = program.opts<GlobalOpts>();
		requireValidFormat(globals, "refresh");
		let term: string;
		const rawTerm = cmdOpts.term as string | undefined;
		if (rawTerm !== undefined) {
			const norm = normalizeTerm(rawTerm);
			if (!norm) {
				emitError(
					"refresh",
					"E_BAD_TERM",
					`Unparseable term '${rawTerm}'.`,
					TERMS_HINT,
					{},
					globals,
					2,
				);
			}
			term = norm.toUpperCase();
		} else {
			term = await defaultTerm();
		}
		try {
			const { meta } = await refreshTerm(term, {
				force: Boolean(cmdOpts.force),
			});
			const data = {
				term: meta.term,
				count: meta.count,
				fetched_at: meta.fetched_at,
				quarantined: meta.quarantined,
				duplicate_ids: meta.duplicate_ids ?? 0,
				hash: meta.hash.slice(0, 12),
			};
			if (wantJson(globals)) {
				emitJson({
					ok: true,
					command: "refresh",
					data,
					meta: { version: VERSION, schema_version: SCHEMA_VERSION },
					next: [`5c search --term ${term} --limit 5`],
					warnings: [],
				});
			} else {
				process.stdout.write(
					`Refreshed ${term}: ${meta.count} sections as of ${meta.fetched_at}.\n`,
				);
			}
		} catch (err) {
			const e = err as { code?: string; message: string };
			if (e.code === "E_FETCH" && hasSnapshot(term)) {
				emitError(
					"refresh",
					"E_FETCH",
					e.message,
					"Serving last-good snapshot; retry shortly.",
					{},
					globals,
					1,
				);
			}
			emitCoreError("refresh", err, globals);
		}
	});

program
	.command("schema")
	.description("Machine catalog of commands/flags (agent introspection)")
	.action(() => {
		const globals = program.opts<GlobalOpts>();
		requireValidFormat(globals, "schema");
		const catalog = {
			name: "5c",
			version: VERSION,
			schema_version: SCHEMA_VERSION,
			commands: program.commands
				.filter((c) => c.name() && c.name() !== "help")
				.map((c) => {
					const args =
						(
							c as unknown as {
								registeredArguments?: {
									name: () => string;
									required: boolean;
								}[];
							}
						).registeredArguments ?? [];
					return {
						name: c.name(),
						args: args.map((a) =>
							a.required ? `<${a.name()}>` : `[${a.name()}]`,
						),
						description: c.description() ?? "",
						flags: c.options.map((o) => {
							const long = o.long ?? o.name();
							const name = long.replace(/^--/, "");
							return {
								name,
								description: o.description ?? "",
								example: FLAG_EXAMPLES[`${c.name()}:${name}`],
							};
						}),
					};
				}),
			exit_codes: {
				0: "success (incl. 0 hits; incl. check ok:false = audit complete, schedule invalid)",
				1: "runtime/fetch",
				2: "usage (bad flags, unparseable terms, unpublished terms)",
				3: "not-found (unknown/ambiguous IDs)",
			},
			id_format:
				"CSCI 051 PO-01 FA2026 ({DEPT} {NUM:03d}{suffix} {SCHOOL}-{SEC:02d} {TERM})",
			term_format: "FA2026 (FA|SP|SU + YYYY)",
			schools: [
				"PO",
				"CM",
				"HM",
				"SC",
				"PZ",
				"KS",
				"JP",
				"JT",
				"JM",
				"AF",
				"CH",
				"AA",
				"CG",
			],
		};
		if (wantJson(globals))
			emitJson({
				ok: true,
				command: "schema",
				data: catalog,
				meta: { version: VERSION, schema_version: SCHEMA_VERSION },
				next: [],
				warnings: [],
			});
		else process.stdout.write(`${JSON.stringify(catalog, null, 1)}\n`);
	});

program
	.command("version")
	.description(
		"Print version + schema version + cached data freshness (offline; never fetches)",
	)
	.action(async () => {
		const globals = program.opts<GlobalOpts>();
		requireValidFormat(globals, "version");
		// Disk-only: version must work with the network down.
		const file = await readCurrentTermFile();
		const meta = file ? await peekTermMeta(file.value) : null;
		const data = {
			version: VERSION,
			schema_version: SCHEMA_VERSION,
			data_term: file?.value ?? null,
			data_fetched_at: meta?.fetched_at ?? null,
		};
		if (wantJson(globals)) {
			emitJson({
				ok: true,
				command: "version",
				data,
				meta: { version: VERSION, schema_version: SCHEMA_VERSION },
				next: [],
				warnings: [],
			});
		} else {
			process.stdout.write(
				`5c ${VERSION} (schema ${SCHEMA_VERSION})${data.data_term ? ` data ${data.data_term}` : ""}${data.data_fetched_at ? ` as of ${data.data_fetched_at}` : ""}\n`,
			);
		}
	});

/** Curated examples for the derived schema catalog. */
const FLAG_EXAMPLES: Record<string, string> = {
	"search:school": "--school pitzer,pomona",
	"search:dept": "--dept CSCI",
	"search:code": '--code "CSCI 051"',
	"search:days": "--days TR",
	"search:after": "--after 1pm",
	"search:before": "--before 5pm",
	"search:open": "--open",
	"search:instructor": "--instructor Dodds",
	"search:area": "--area HIST",
	"search:credits": "--credits 0.5-1",
	"search:term": "--term FA2026",
	"search:fallback-term": "--fallback-term",
	"search:exclude-conflicts-with":
		'--exclude-conflicts-with "CSCI 005 HM-01 FA2026"',
	"search:limit": "--limit 10",
	"search:offset": "--offset 10",
	"search:sort": "--sort seats",
	"search:explain": "--explain",
	"search:fields": "--fields id,title,seats_open",
	"get:term": "--term FA2026",
	"get:fallback-term": "--fallback-term",
	"check:against": '--against "MATH 019 HM-01 FA2026"',
	"check:block": '--block "MWF 10:00-10:50"',
	"check:file": "--file sched.json",
	"check:stdin": "--stdin",
	"check:term": "--term FA2026",
	"check:fallback-term": "--fallback-term",
	"check:passing-minutes": "--passing-minutes 15",
	"terms:limit": "--limit 6",
	"history:campus": "--campus PO",
	"history:school": "--school PO",
	"history:limit": "--limit 6",
	"history:term": "--term FA2026",
	"history:fallback-term": "--fallback-term",
	"refresh:term": "--term FA2026",
	"refresh:force": "--force",
};

const KNOWN_FLAGS = collectKnownFlags(program);

// One guard for every command: Commander consumes the next token as a value
// even when it is another flag (`--instructor --limit` eats `--limit`), which
// silently turns a typo into a weird filter. Catch it after parsing, before
// any work, and exit 2.
program.hook("preAction", (_thisCommand, actionCommand) => {
	const values: (string | string[] | undefined)[] = [];
	for (const v of Object.values(actionCommand.opts())) {
		if (typeof v === "string") values.push(v);
		else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
			values.push(v as string[]);
		}
	}
	values.push(...actionCommand.args.filter((a) => typeof a === "string"));
	guardFlagSwallow(actionCommand.name(), values, KNOWN_FLAGS, argvGlobals());
});

// ---------- commander-level failure envelope ----------

function argvGlobals(): GlobalOpts {
	const argv = process.argv;
	const out: GlobalOpts = {};
	if (argv.includes("--json")) out.json = true;
	const eq = argv.find((a) => a.startsWith("--format="));
	if (eq) {
		out.format = eq.slice("--format=".length);
	} else {
		const i = argv.indexOf("--format");
		if (i >= 0 && argv[i + 1]) out.format = argv[i + 1];
	}
	return out;
}

function argvCommand(): string {
	const known = new Set([
		"search",
		"get",
		"check",
		"terms",
		"history",
		"schema",
		"version",
		"refresh",
	]);
	for (const a of process.argv.slice(2)) {
		if (a.startsWith("-")) continue;
		return known.has(a) ? a : "5c";
	}
	return "5c";
}

function commanderHint(msg: string): string | null {
	const unknown = msg.match(/unknown option '([^']+)'/);
	if (unknown) {
		const raw = unknown[1];
		if (
			raw.includes("=") &&
			[
				"--open",
				"--explain",
				"--json",
				"--force",
				"--stdin",
				"--no-color",
				"--non-interactive",
				"--fallback-term",
			].some((b) => raw === b || raw.startsWith(`${b}=`))
		) {
			const base = raw.split("=")[0];
			return `Boolean flags take no value — use '${base}' to enable or omit it.`;
		}
		return "Run `5c --help` or `5c <command> --help` for valid flags.";
	}
	if (/too many arguments/.test(msg)) {
		return "Check positional args: get takes 1 ID; check takes IDs and/or --file/--stdin.";
	}
	if (/missing required argument|required option/.test(msg)) {
		return 'See usage: `5c <command> --help`. Example: 5c get "CSCI 005 HM-01 FA2026".';
	}
	if (/option .* argument missing|argument missing/.test(msg)) {
		return "Every value-taking flag needs its value, e.g. --limit 5.";
	}
	if (/unknown command/.test(msg)) {
		return "Run `5c --help` for the command list.";
	}
	return "Run `5c --help` for usage.";
}

program.parseAsync(process.argv).catch((err) => {
	// Commander-level failures (unknown option, excess/missing args,
	// --flag=value misuse) surface here via exitOverride: return the JSON
	// envelope + exit 2, never plain text.
	const code = (err as { code?: string })?.code ?? "";
	if (code.startsWith("commander.")) {
		if (
			code === "commander.helpDisplayed" ||
			code === "commander.help" ||
			code === "commander.version"
		) {
			process.exit((err as CommanderError).exitCode ?? 0);
		}
		const globals = argvGlobals();
		const message = String((err as Error).message ?? err).replace(
			/^error:\s*/,
			"",
		);
		emitError(
			argvCommand(),
			"E_USAGE",
			message,
			commanderHint(message),
			{},
			globals,
			2,
		);
	}
	const globals: GlobalOpts = { json: process.argv.includes("--json") };
	emitError(
		"5c",
		"E_INTERNAL",
		(err as Error).message ?? String(err),
		null,
		{},
		globals,
		1,
	);
});
