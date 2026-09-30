/**
 * 5c-mcp — MCP server over the shared 5c-core engine.
 *
 * - Default: stdio transport (Claude Code / Codex / Cursor / Desktop).
 * - --http: stateless Streamable HTTP on POST /mcp, localhost-only by default
 *   (experimental; hosting is not a supported distribution yet).
 * - Logs to stderr ONLY. Never write to stdout except MCP messages.
 *
 * Every tool declares an inputSchema AND an outputSchema (src/schemas.ts), so
 * the advertised shape is the validated shape. Unknown params are REJECTED,
 * not ignored: z.object({...}).strict() makes the SDK fail the call with
 * -32602 naming the key (e.g. "Unrecognized key: 'open_only'"). A closest-match
 * "did you mean?" is NOT implemented because the SDK validates before handlers
 * run, so there is no interception point — common confusions (open_only,
 * instructors) are named in the search_classes description instead.
 *
 * Importing this module does NOT start the server; only running the built
 * entry point does (see `isDirectRun`), which keeps tests free to import
 * `createMcpServer`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
	checkScheduleByIds,
	getClasses,
	getCourseHistory,
	listTerms,
	searchClasses,
} from "5c-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toolError } from "./errors.js";
import {
	type CheckOutput,
	type GetOutput,
	type HistoryOutput,
	type SearchOutput,
	type TermsOutput,
	checkInputSchema,
	checkOutputSchema,
	getInputSchema,
	getOutputSchema,
	historyInputSchema,
	historyOutputSchema,
	searchInputSchema,
	searchOutputSchema,
	termsInputSchema,
	termsOutputSchema,
} from "./schemas.js";
import {
	checkText,
	getText,
	historyText,
	searchText,
	termsText,
} from "./text.js";

const VERSION = packageVersion();
const SEATS_NOTE = "Seats are a snapshot; verify in CX before enrolling.";
const READONLY = { readOnlyHint: true, openWorldHint: true } as const;
/** Stateless HTTP: no request may exceed this before we hang up. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

function packageVersion(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const INSTRUCTIONS = `5C course search (Pomona, CM/Claremont McKenna, Harvey Mudd, Scripps, Pitzer).
Workflow: list_terms if the term is vague -> search_classes (limit 10) -> get_classes to expand -> check_schedule to validate.
Page with offset/next_offset/has_more (+total_count); don't widen queries. Seats are snapshots: always state fetched_at ("as of ..."). Never promise enrollment.
Honesty rules: an unpublished term is an error, not a substitution, unless you pass allow_term_fallback. check_schedule ok:true does not mean complete:true — TBA sections are not checked. Report quarantined > 0 as incomplete coverage.`;

/**
 * Factory: one McpServer per connection. The SDK forbids connecting the same
 * server instance to two transports, so stateless HTTP creates a fresh
 * instance per POST (tool registrations are cheap; core caches are shared).
 */
export function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "5c-index", version: VERSION },
		{ instructions: INSTRUCTIONS },
	);
	registerTools(server);
	return server;
}

/** Tool payloads: exactly the keys the output schema advertises, no spread. */
function okPayload<T extends Record<string, unknown>>(payload: T) {
	return { structuredContent: payload as { [x: string]: unknown } };
}

function registerTools(server: McpServer): void {
	// ---------- search_classes ----------

	server.registerTool(
		"search_classes",
		{
			title: "Search 5C Classes",
			description:
				'Search current/upcoming 5C course offerings by keyword, department, campus, time, instructor, seats. USE for all discovery queries (\'CS classes at Mudd Tuesday afternoons with open seats\'). Do NOT use to validate a fixed schedule (use check_schedule) or for full details (use get_classes with returned IDs). Trust registrar status (O/C/R), not seat arithmetic: availability:"has_seat" means the registrar says registrable. TBA sections never match day/time filters. Unknown parameters are rejected — use availability (not open_only) and instructor singular (not instructors). Example: {"query":"microeconomics","schools":["PO","CM"],"term":"FA2026","availability":"has_seat","limit":10}.',
			inputSchema: searchInputSchema,
			outputSchema: searchOutputSchema,
			annotations: { ...READONLY },
		},
		async (args) => {
			try {
				const credits =
					args.credits_min !== undefined || args.credits_max !== undefined
						? `${args.credits_min ?? 0}-${args.credits_max ?? 999}`
						: undefined;
				const { result, normalized, meta, fallback, warning } =
					await searchClasses(args.query ?? "", {
						term: args.term,
						schools: args.schools,
						depts: args.departments,
						code: args.code,
						days: args.days?.join(""),
						after: args.starts_after,
						before: args.ends_before,
						instructor: args.instructor,
						areas: args.course_areas,
						open: args.availability === "has_seat" ? true : undefined,
						credits,
						sort: args.sort,
						explain: args.explain,
						excludeConflictsWith: args.exclude_conflicts_with,
						limit: args.limit,
						offset: args.offset,
						allowTermFallback: args.allow_term_fallback,
					});
				const payload: SearchOutput = {
					term: result.term,
					total_count: result.total,
					has_more: result.has_more,
					next_offset: result.next_offset,
					hits: result.hits,
					hint: result.hint,
					suggestions: result.suggestions,
					snapshot_id: result.snapshot_id,
					applied_filters: normalized,
					seats_note: SEATS_NOTE,
					fetched_at: meta.fetched_at,
					stale: meta.stale,
					quarantined: meta.quarantined,
					duplicate_ids: meta.duplicate_ids,
					...(fallback ? { fallback } : {}),
					...(warning ? { warning } : {}),
				};
				return {
					content: [{ type: "text" as const, text: searchText(payload) }],
					...okPayload(payload),
				};
			} catch (err) {
				return toolError(err);
			}
		},
	);

	// ---------- get_classes ----------

	server.registerTool(
		"get_classes",
		{
			title: "Get Class Details",
			description:
				'Fetch full details for 1-20 class IDs from a prior search_classes call (description, seats, all meeting blocks, areas, dates). USE to expand hits before presenting or before check_schedule. Do NOT use for discovery — requires IDs. Unknown IDs come back in not_found with suggestions; loose IDs that match several sections come back in ambiguous (ask the user, never pick for them). Example: {"ids":["CSCI 051 PO-01 FA2026"]}.',
			inputSchema: getInputSchema,
			outputSchema: getOutputSchema,
			annotations: { ...READONLY },
		},
		async (args) => {
			try {
				const { result, meta, fallback, warning } = await getClasses(args.ids, {
					term: args.term,
					allowTermFallback: args.allow_term_fallback,
				});
				const payload: GetOutput = {
					classes: result.classes,
					not_found: result.not_found,
					ambiguous: result.ambiguous,
					suggestions: result.suggestions,
					terms: result.terms,
					fetched_at: meta.fetched_at,
					stale: meta.stale,
					quarantined: meta.quarantined,
					duplicate_ids: meta.duplicate_ids,
					...(fallback ? { fallback } : {}),
					...(warning ? { warning } : {}),
				};
				// Partial success is still success; nothing resolved is an error.
				const nothingResolved = payload.classes.length === 0;
				return {
					content: [{ type: "text" as const, text: getText(payload) }],
					...okPayload(payload),
					...(nothingResolved ? { isError: true } : {}),
				};
			} catch (err) {
				return toolError(err);
			}
		},
	);

	// ---------- check_schedule ----------

	server.registerTool(
		"check_schedule",
		{
			title: "Check Schedule Conflicts",
			description:
				'Audit 1-20 class IDs for time conflicts, cross-campus travel risk, credit totals, and closed sections. USE whenever the user asks \'can I take A+B?\', \'does this schedule work?\'. Do NOT use for finding classes. The server does all time math — never compute overlaps yourself. Read complete/skipped_tba: TBA sections are not checked, so ok:true with complete:false is a partial answer. Half-semester sections only conflict on overlapping dates. Example: {"ids":["CSCI 051 PO-01 FA2026","MATH 031 PO-02 FA2026"],"term":"FA2026"}.',
			inputSchema: checkInputSchema,
			outputSchema: checkOutputSchema,
			annotations: { ...READONLY },
		},
		async (args) => {
			try {
				const { result, resolved, meta, terms, fallback, warning } =
					await checkScheduleByIds(args.ids, {
						term: args.term,
						passingMinutes: args.passing_minutes,
						allowTermFallback: args.allow_term_fallback,
					});
				const payload: CheckOutput = {
					ok: result.ok,
					complete: result.complete,
					skipped_tba: result.skipped_tba,
					total_credits: result.total_credits,
					class_count: result.class_count,
					conflicts: result.conflicts,
					travel_warnings: result.travel_warnings,
					seat_problems: result.seat_problems,
					warnings: result.warnings,
					weekly_grid: result.weekly_grid,
					checked: resolved,
					terms,
					fetched_at: meta.fetched_at,
					stale: meta.stale,
					quarantined: meta.quarantined,
					duplicate_ids: meta.duplicate_ids,
					...(fallback ? { fallback } : {}),
					...(warning ? { warning } : {}),
				};
				return {
					content: [{ type: "text" as const, text: checkText(payload) }],
					...okPayload(payload),
				};
			} catch (err) {
				return toolError(err);
			}
		},
	);

	// ---------- list_terms ----------

	server.registerTool(
		"list_terms",
		{
			title: "List Academic Terms",
			description:
				"List available term codes with labels (e.g. FA2026 = Fall 2026). USE first when the user's term is ambiguous ('next semester', 'fall') or before search_classes with an explicit term. Do NOT call repeatedly — cache the result for the session. Example: {}.",
			inputSchema: termsInputSchema,
			outputSchema: termsOutputSchema,
			annotations: { ...READONLY },
		},
		async (args) => {
			try {
				const { current, available } = await listTerms({ limit: args.limit });
				const payload: TermsOutput = {
					current_term: current,
					terms: available,
				};
				return {
					content: [{ type: "text" as const, text: termsText(payload) }],
					...okPayload(payload),
				};
			} catch (err) {
				return toolError(err);
			}
		},
	);

	// ---------- get_course_history ----------

	server.registerTool(
		"get_course_history",
		{
			title: "Get Course History",
			description:
				'Show past offerings of a course across terms (instructors, terms offered, rotation signal). USE for \'who usually teaches X?\', \'how often is X offered?\', \'is it likely in spring?\'. Do NOT use for current availability (use search_classes). The rotation_note names the window actually observed — never claim a pattern the note does not support. Example: {"code":"ECON 101","schools":["PO"]}.',
			inputSchema: historyInputSchema,
			outputSchema: historyOutputSchema,
			annotations: { ...READONLY },
		},
		async (args) => {
			try {
				const h = await getCourseHistory(args.code, {
					campuses: args.schools,
					limit: args.limit,
					term: args.term,
					allowTermFallback: args.allow_term_fallback,
				});
				const payload: HistoryOutput = {
					code: h.code,
					offerings: h.offerings,
					rotation_note: h.rotation_note,
					verdict: h.verdict,
					fetched_at: h.fetched_at,
					stale: h.stale,
					snapshot_term: h.snapshot_term,
					...(h.enrichment ? { enrichment: h.enrichment } : {}),
					...(h.fallback ? { fallback: h.fallback } : {}),
					...(h.warning ? { warning: h.warning } : {}),
				};
				return {
					content: [{ type: "text" as const, text: historyText(payload) }],
					...okPayload(payload),
				};
			} catch (err) {
				return toolError(err);
			}
		},
	);
}

// ---------- transports ----------

async function serveStdio(): Promise<void> {
	await createMcpServer().connect(new StdioServerTransport());
}

/**
 * Experimental stateless Streamable HTTP. Binds localhost by default and caps
 * the request body, because "public data" is not a reason to expose a port.
 */
async function serveHttp(host: string, port: number): Promise<void> {
	const httpServer = createServer(async (req, res) => {
		if (req.method !== "POST" || req.url?.split("?")[0] !== "/mcp") {
			res.writeHead(req.method === "POST" ? 404 : 405, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify({ error: "Use POST /mcp" }));
			return;
		}
		try {
			let size = 0;
			const body = await new Promise<unknown>((resolve, reject) => {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => {
					size += c.length;
					if (size > MAX_BODY_BYTES) {
						reject(
							Object.assign(new Error("Request body too large"), {
								code: "E_TOO_LARGE",
							}),
						);
						req.destroy();
						return;
					}
					chunks.push(c);
				});
				req.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch (e) {
						reject(e);
					}
				});
				req.on("error", reject);
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // stateless
			});
			// Fresh server per request: the SDK forbids connecting one instance
			// to multiple transports. Registrations are cheap; 5c-core caches
			// (snapshots, indexes) are module-level.
			await createMcpServer().connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (err) {
			const tooLarge = (err as { code?: string }).code === "E_TOO_LARGE";
			console.error("MCP HTTP error:", err);
			if (!res.headersSent) {
				res.writeHead(tooLarge ? 413 : 500, {
					"Content-Type": "application/json",
				});
				res.end(
					JSON.stringify({
						error: tooLarge ? "Body too large" : "Internal error",
					}),
				);
			}
		}
	});
	httpServer.listen(port, host, () => {
		const bound = httpServer.address();
		const actual = typeof bound === "object" && bound ? bound.port : port;
		console.error(
			`5c-mcp listening (stateless Streamable HTTP) on http://${host}:${actual}/mcp`,
		);
	});
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (!args.includes("--http")) {
		await serveStdio();
		return;
	}
	const argValue = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const rawPort = argValue("--port");
	// 0 is meaningful: let the OS pick a free port (used by tests).
	const port = rawPort !== undefined ? Number.parseInt(rawPort, 10) : 3000;
	const binding = Number.isFinite(port) ? port : 3000;
	// Localhost by default: hosting is deferred, and an open port is not a
	// side effect a course-search tool should have.
	const host = argValue("--host") ?? "127.0.0.1";
	await serveHttp(host, binding);
}

/**
 * Only run when executed, never on import (tests import the factory).
 * realpath matters twice over: /tmp is a symlink on macOS, and an installed
 * bin is a symlink in node_modules/.bin — either would otherwise look like an
 * import and the server would silently do nothing.
 */
export const isDirectRun = ((): boolean => {
	const argv1 = process.argv[1];
	if (!argv1) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
	} catch {
		return import.meta.url === pathToFileURL(argv1).href;
	}
})();

if (isDirectRun) {
	main().catch((err) => {
		console.error("5c-mcp fatal:", err);
		process.exit(1);
	});
}
