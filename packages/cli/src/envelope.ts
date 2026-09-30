/**
 * Output envelope for the 5c CLI.
 *
 * Sacred conventions:
 * - stdout = exactly one JSON document (in --json / piped mode). Nothing else.
 * - stderr = humans, warnings, errors in TTY mode.
 * - Exit 0 success (incl. 0 hits) · 1 runtime · 2 usage · 3 not-found.
 * - Never prompt, never page.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";

export const SCHEMA_VERSION = 1;

export interface GlobalOpts {
	json?: boolean;
	format?: string;
}

/** Strict integer: digits only. "2junk" is rejected, not parseInt'd to 2. */
export function parseIntStrict(raw: unknown): number | null {
	const s = String(raw ?? "").trim();
	if (!/^\d+$/.test(s)) return null;
	const n = Number.parseInt(s, 10);
	return Number.isFinite(n) ? n : null;
}

// TTY -> table, piped -> json. --json forces JSON.
export function wantJson(opts: GlobalOpts): boolean {
	if (opts.json) return true;
	if (opts.format === "json") return true;
	if (opts.format === "table") return false;
	return !process.stdout.isTTY;
}

export function emitJson(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj, null, 1)}\n`);
}

const RETRYABLE_CODES = new Set(["E_FETCH", "E_NO_CURRENT_TERM"]);

export function emitError(
	command: string,
	code: string,
	message: string,
	hint: string | null,
	extra: Record<string, unknown>,
	globals: GlobalOpts,
	exitCode: number,
): never {
	const retryable = extra.retryable ?? RETRYABLE_CODES.has(code);
	if (wantJson(globals)) {
		emitJson({
			ok: false,
			command,
			error: { code, message, hint, retryable, ...extra },
			meta: { version: cliVersion(), schema_version: SCHEMA_VERSION },
			next: [],
		});
	} else {
		process.stderr.write(`5c ${command}: error [${code}]: ${message}\n`);
		if (hint) process.stderr.write(`hint: ${hint}\n`);
	}
	process.exit(exitCode);
}

let versionCache: string | null = null;
export function cliVersion(): string {
	if (versionCache) return versionCache;
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		versionCache = pkg.version;
	} catch {
		versionCache = "0.1.0";
	}
	return versionCache;
}

/**
 * Ingest counts travel with every result: a nonzero count means this answer
 * stands on partial data, and TTY users must be told as well as JSON ones.
 */
export function ingestWarnings(meta: {
	quarantined?: number;
	duplicate_ids?: number;
}): string[] {
	const out: string[] = [];
	if ((meta.quarantined ?? 0) > 0) {
		out.push(
			`ingest dropped ${meta.quarantined} row(s); coverage may be incomplete`,
		);
	}
	if ((meta.duplicate_ids ?? 0) > 0) {
		out.push(
			`${meta.duplicate_ids} row(s) collapsed onto an existing ID at ingest`,
		);
	}
	return out;
}

export function splitList(v: string[] | undefined): string[] {
	if (!v) return [];
	return v
		.flatMap((x) => x.split(","))
		.map((x) => x.trim())
		.filter(Boolean);
}

export function pickFields<T extends Record<string, unknown>>(
	obj: T,
	fields: string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of fields) if (f in obj) out[f] = obj[f];
	return out;
}

/** Projectable search-hit keys for --fields. */
export const KNOWN_HIT_FIELDS = new Set([
	"id",
	"term",
	"school",
	"code",
	"section",
	"title",
	"instructors",
	"days",
	"start",
	"end",
	"meetings",
	"credits",
	"potential_error",
	"seats_open",
	"seats_total",
	"status",
	"match",
	"fetched_at",
	"stale",
]);

export const TERMS_HINT = "Run `5c terms` for valid terms.";
export const CODE_HINT =
	"Try --code 'CSCI 051', --code CSCI, or --code 'CSCI 051 PO'.";
export const FILE_IDS_HINT =
	'Provide ["ID1","ID2"] or {"sections":["ID1","ID2"]}, e.g. {"sections":["CSCI 005 HM-01 FA2026"]}.';

/** Derive the flag set from the actual commander definitions (no hand list). */
export function collectKnownFlags(program: Command): Set<string> {
	const out = new Set<string>();
	for (const opt of program.options) {
		if (opt.long) out.add(opt.long);
	}
	for (const cmd of program.commands) {
		for (const opt of cmd.options) {
			if (opt.long) out.add(opt.long);
		}
	}
	// Negations register as --no-x; accept both spellings.
	for (const f of [...out]) {
		if (f.startsWith("--no-")) out.add(`--${f.slice(5)}`);
	}
	return out;
}

/**
 * Commander consumes the next token as a value even when it is another flag
 * (e.g. `--instructor --limit` eats `--limit`). Catch that as E_USAGE.
 */
export function guardFlagSwallow(
	command: string,
	values: (string | string[] | undefined)[],
	knownFlags: Set<string>,
	globals: GlobalOpts,
): void {
	for (const v of values) {
		const items = Array.isArray(v) ? v : v === undefined ? [] : [v];
		for (const item of items) {
			for (const part of String(item).split(",")) {
				const base = part.trim().split("=")[0];
				if (base.startsWith("--") && knownFlags.has(base)) {
					emitError(
						command,
						"E_USAGE",
						`Option value '${part.trim()}' looks like a flag — a value is missing.`,
						"Every value-taking flag needs its value, e.g. --instructor NAME --limit 5.",
						{},
						globals,
						2,
					);
				}
			}
		}
	}
}

export function requireValidFormat(globals: GlobalOpts, command: string): void {
	if (
		globals.format !== undefined &&
		globals.format !== "json" &&
		globals.format !== "table"
	) {
		emitError(
			command,
			"E_USAGE",
			`Bad --format '${globals.format}'.`,
			"Valid: json|table.",
			{},
			globals,
			2,
		);
	}
}

/** One shared mapping from core error codes to the CLI envelope + exit codes. */
export function emitCoreError(
	command: string,
	err: unknown,
	globals: GlobalOpts,
): never {
	const e = err as {
		code?: string;
		message: string;
		hint?: string;
		available?: string[];
		not_found?: string[];
	};
	// An unpublished term is a usage problem, and the hint has to name the
	// terms that DO exist; both codes land in the same envelope.
	if (e.code === "E_BAD_TERM" || e.code === "E_TERM_NOT_FOUND") {
		emitError(
			command,
			"E_BAD_TERM",
			e.message,
			e.available?.length
				? `Available terms: ${e.available.join(", ")}. Retry with one of those, or --fallback-term to serve the newest.`
				: TERMS_HINT,
			{ available: e.available ?? [] },
			globals,
			2,
		);
	}
	if (e.code === "E_NO_CURRENT_TERM") {
		emitError(
			command,
			"E_NO_CURRENT_TERM",
			e.message,
			e.hint ?? TERMS_HINT,
			{},
			globals,
			1,
		);
	}
	if (e.code === "E_BAD_FILTER" || e.code === "E_USAGE") {
		emitError(command, e.code, e.message, e.hint ?? null, {}, globals, 2);
	}
	if (e.code === "E_NOT_FOUND") {
		emitError(
			command,
			"E_NOT_FOUND",
			e.message,
			e.hint ?? "Search first, then pass IDs verbatim.",
			{ not_found: e.not_found ?? [] },
			globals,
			3,
		);
	}
	emitError(command, "E_FETCH", e.message, null, {}, globals, 1);
}
