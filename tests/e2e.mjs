#!/usr/bin/env node
/**
 * 5C Index end-to-end harness: CLI matrix + MCP matrix (stdio and HTTP) +
 * skill/evals spec checks.
 *
 * Default run is OFFLINE: every data check goes through tests/fixture-server.mjs
 * with a fresh FIVE_C_DATA_DIR, so cold paths are still exercised but nothing
 * depends on the registrar being up or on today's seat counts.
 *
 * Live checks (real HyperSchedule, real seat rankings) run only with --live or
 * FIVE_C_LIVE=1. Keep it that way: a red release gate must mean the code broke,
 * not that enrollment shifted.
 *
 * Usage: pnpm e2e            (offline)
 *        pnpm e2e:live       (offline + network suite)
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FA2026,
	UNPUBLISHED_TERM,
	startFixtureServer,
} from "./fixture-server.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(ROOT, "packages/cli/dist/index.js");
const MCP = join(ROOT, "packages/mcp/dist/server.js");
const CACHE = mkdtempSync(join(tmpdir(), "5c-e2e-"));
const LIVE = process.argv.includes("--live") || process.env.FIVE_C_LIVE === "1";

const fixture = await startFixtureServer();
const ENV = {
	...process.env,
	FIVE_C_DATA_DIR: CACHE,
	FIVE_C_API_BASE: fixture.url,
	NO_COLOR: "1",
};
const LIVE_ENV = { ...process.env, FIVE_C_DATA_DIR: CACHE, NO_COLOR: "1" };

let passed = 0;
let failed = 0;
const failures = [];
const timings = {};

function check(name, cond, detail = "") {
	if (cond) {
		passed++;
	} else {
		failed++;
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function cli(args, env = ENV) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		execFile(
			process.execPath,
			[CLI, ...args],
			{ env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({
					code: typeof err?.code === "number" ? err.code : 0,
					stdout,
					stderr,
					ms: Date.now() - t0,
				});
			},
		);
	});
}

async function cliJson(args, env = ENV) {
	const r = await cli(args, env);
	let json = null;
	try {
		json = JSON.parse(r.stdout);
	} catch {
		/* caller asserts on json being non-null */
	}
	return { ...r, json };
}

// ---------------- MCP stdio client ----------------
// Protocol-aware: responses are matched by id, no sleeps, and the process is
// always reaped.
function mcpStdio(env = ENV) {
	const child = spawn(process.execPath, [MCP], { env });
	const pending = new Map();
	let buffer = "";
	let stderr = "";
	let nextId = 1;

	child.stdout.on("data", (d) => {
		buffer += d.toString();
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				try {
					const msg = JSON.parse(line);
					const waiter = msg.id !== undefined ? pending.get(msg.id) : null;
					if (waiter) {
						pending.delete(msg.id);
						waiter(msg);
					}
				} catch {
					/* non-JSON noise on stdout would be a bug; ignore for parsing */
				}
			}
			idx = buffer.indexOf("\n");
		}
	});
	child.stderr.on("data", (d) => {
		stderr += d.toString();
	});

	function notify(method, params) {
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	function request(method, params, timeoutMs = 30000) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`MCP timeout: ${method}`));
			}, timeoutMs);
			pending.set(id, (msg) => {
				clearTimeout(timer);
				if (msg.error) reject(new Error(JSON.stringify(msg.error)));
				else resolve(msg.result);
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	return {
		async initialize() {
			await request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "e2e", version: "0" },
			});
			notify("notifications/initialized");
		},
		listTools: () => request("tools/list", {}).then((r) => r.tools),
		call: (name, args) => request("tools/call", { name, arguments: args }),
		stderr: () => stderr,
		close() {
			try {
				child.stdin.end();
			} catch {}
			try {
				child.kill();
			} catch {}
		},
	};
}

const textOf = (result) =>
	(result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");

// ---------------- CLI (offline) ----------------
console.log("== CLI (offline fixture) ==");
{
	const t = await cliJson(["terms", "--json"]);
	check("terms exit 0", t.code === 0);
	check("terms current FA2026", t.json?.data?.current === FA2026);
	check("terms sorted desc", t.json?.data?.terms?.[0]?.code === FA2026);
	check("terms next hint", t.json?.next?.[0]?.includes(FA2026) ?? false);
}
{
	const t = await cliJson(["version", "--json"], {
		...ENV,
		FIVE_C_API_BASE: "http://127.0.0.1:9",
	});
	check("version offline exit 0", t.code === 0, `exit=${t.code}`);
	check("version schema 1", t.json?.data?.schema_version === 1);
}
{
	const t = await cliJson(["schema", "--json"]);
	const names = (t.json?.data?.commands ?? []).map((c) => c.name);
	for (const c of [
		"search",
		"get",
		"check",
		"terms",
		"history",
		"schema",
		"version",
		"refresh",
	]) {
		check(`schema lists ${c}`, names.includes(c));
	}
	check(
		"schema exit codes documented",
		(t.json?.data?.exit_codes?.["3"] ?? "").includes("not-found"),
	);
}
{
	const t = await cliJson([
		"search",
		"--dept",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--limit",
		"2",
	]);
	check("search exit 0", t.code === 0);
	check("search term echoed", t.json?.data?.term === FA2026);
	check("search snapshot id", typeof t.json?.data?.snapshot_id === "string");
	check("search envelope warnings", Array.isArray(t.json?.warnings));
	check(
		"search ingest counts surfaced",
		t.json?.meta?.quarantined === 1,
		JSON.stringify(t.json?.meta?.quarantined),
	);
	timings.search_cold_ms = t.ms;
}
{
	// Pagination walk: continuity, uniqueness, determinism.
	const seen = [];
	let offset = 0;
	let total = -1;
	for (let i = 0; i < 10; i++) {
		const t = await cliJson([
			"search",
			"--dept",
			"CSCI",
			"--term",
			FA2026,
			"--json",
			"--limit",
			"1",
			"--offset",
			String(offset),
		]);
		total = t.json?.data?.total ?? -1;
		seen.push(...(t.json?.data?.hits ?? []).map((h) => h.id));
		if (!t.json?.data?.has_more) break;
		offset = t.json.data.next_offset;
	}
	check("pagination total", total === 3, `total=${total}`);
	check(
		"pagination complete",
		seen.length === total,
		`${seen.length}/${total}`,
	);
	check("pagination unique", new Set(seen).size === seen.length);
	const past = await cliJson([
		"search",
		"--dept",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--offset",
		"99",
	]);
	check(
		"offset past end says so",
		(past.json?.data?.hint ?? "").includes("past the end"),
		past.json?.data?.hint,
	);
}
{
	// Filters: school normalization, status-based availability, sort, explain.
	const pz = await cliJson([
		"search",
		"psychology",
		"--school",
		"pitzer",
		"--term",
		FA2026,
		"--json",
	]);
	check(
		"school filter normalizes PZ",
		(pz.json?.data?.hits ?? []).length > 0 &&
			(pz.json?.data?.hits ?? []).every((h) => h.school === "PZ"),
	);
	const closed = await cliJson([
		"search",
		"--dept",
		"BIOL",
		"--term",
		FA2026,
		"--json",
	]);
	const openOnly = await cliJson([
		"search",
		"--dept",
		"BIOL",
		"--open",
		"--term",
		FA2026,
		"--json",
	]);
	check(
		"closed-with-spare excluded by --open",
		closed.json?.data?.total === 1 && openOnly.json?.data?.total === 0,
	);
	const bySeats = await cliJson([
		"search",
		"--code",
		"CSCI 05",
		"--sort",
		"seats",
		"--term",
		FA2026,
		"--json",
	]);
	const seats = (bySeats.json?.data?.hits ?? []).map((h) => h.seats_open);
	check(
		"sort=seats desc",
		seats.length === 2 && seats[0] >= seats[1],
		JSON.stringify(seats),
	);
	const explain = await cliJson([
		"search",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--limit",
		"1",
		"--explain",
	]);
	check(
		"explain why",
		(explain.json?.data?.hits?.[0]?.match?.why?.length ?? 0) > 0,
	);
	const fields = await cliJson([
		"search",
		"--dept",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--fields",
		"id,title",
	]);
	check(
		"fields projection",
		(fields.json?.data?.hits ?? []).every(
			(h) => Object.keys(h).sort().join(",") === "id,title",
		),
	);
}
{
	// --code digit rule: 1 or 3 digits exact, 2 digits family.
	const family = await cliJson([
		"search",
		"--code",
		"CSCI 05",
		"--term",
		FA2026,
		"--json",
	]);
	check("code family 050-059", family.json?.data?.total === 2);
	const exact = await cliJson([
		"search",
		"--code",
		"CSCI 5",
		"--term",
		FA2026,
		"--json",
	]);
	check(
		"code 1-digit exact",
		exact.json?.data?.hits?.[0]?.id === "CSCI 005 HM-01 FA2026",
		exact.json?.data?.hits?.[0]?.id,
	);
	const deptWide = await cliJson([
		"search",
		"--code",
		"CSCI",
		"--term",
		FA2026,
		"--json",
	]);
	check("code dept-wide", deptWide.json?.data?.total === 3);
}
{
	const t = await cliJson(["get", "BIOL 040 PO-01 FA2026", "--json"]);
	check(
		"get full detail with both blocks",
		t.json?.data?.id === "BIOL 040 PO-01 FA2026" &&
			t.json?.data?.meetings?.length === 2,
		JSON.stringify(t.json?.data?.meetings?.length),
	);
	const tba = await cliJson(["get", "HIST 100 PO-01 FA2026", "--json"]);
	check(
		"get TBA has no meetings",
		(tba.json?.data?.meetings ?? [null]).length === 0,
	);
	const flagged = await cliJson(["get", "PHYS 070 HM-01 FA2026", "--json"]);
	check(
		"get warns on potential_error",
		(flagged.json?.warnings ?? []).some((w) => w.includes("potential_error")),
		JSON.stringify(flagged.json?.warnings),
	);
	const alias = await cliJson([
		"get",
		"csci 5 hm 1",
		"--term",
		FA2026,
		"--json",
	]);
	check(
		"get loose facets resolve when unique",
		alias.json?.data?.id === "CSCI 005 HM-01 FA2026",
		alias.json?.data?.id,
	);
	const ambiguous = await cliJson([
		"get",
		"CSCI 50",
		"--term",
		FA2026,
		"--json",
	]);
	check("get ambiguous exit 3", ambiguous.code === 3, `exit=${ambiguous.code}`);
	check(
		"get ambiguous lists candidates",
		(ambiguous.json?.error?.did_you_mean ?? []).length === 2,
		JSON.stringify(ambiguous.json?.error?.did_you_mean),
	);
	const nearMiss = await cliJson(["get", "CSCI 999 PO-01 FA2026", "--json"]);
	check("get near-miss exit 3", nearMiss.code === 3, `exit=${nearMiss.code}`);
	check(
		"get near-miss code",
		nearMiss.json?.ok === false && nearMiss.json?.error?.code === "E_NOT_FOUND",
	);
	const garbage = await cliJson(["get", "zzz qqq", "--term", FA2026, "--json"]);
	check("get garbage exit 3", garbage.code === 3 && garbage.json?.ok === false);
}
{
	const a = "CSCI 005 HM-01 FA2026";
	const b = "BIOL 040 PO-01 FA2026";
	const t = await cliJson(["check", a, b, "--json"]);
	check(
		"check finds hard conflict",
		t.json?.data?.ok === false &&
			(t.json?.data?.conflicts ?? []).some((c) => c.severity === "hard"),
	);
	check(
		"check reports closed section",
		(t.json?.data?.seat_problems ?? []).some((s) => s.id === b),
	);
	check(
		"check lists both as checked",
		JSON.stringify(t.json?.data?.checked) === JSON.stringify([a, b]),
	);
	const clean = await cliJson([
		"check",
		"CSCI 005 HM-01 FA2026",
		"MATH 019 HM-01 FA2026",
		"--json",
	]);
	check(
		"check clean pair ok + complete",
		clean.json?.data?.ok === true && clean.json?.data?.complete === true,
		JSON.stringify(clean.json?.data),
	);
	check(
		"check no travel warning same campus",
		(clean.json?.data?.travel_warnings ?? []).length === 0,
	);
	const tba = await cliJson([
		"check",
		"HIST 100 PO-01 FA2026",
		"CSCI 005 HM-01 FA2026",
		"--json",
	]);
	check(
		"check TBA marks audit incomplete",
		tba.json?.data?.ok === true &&
			tba.json?.data?.complete === false &&
			JSON.stringify(tba.json?.data?.skipped_tba) ===
				JSON.stringify(["HIST 100 PO-01 FA2026"]),
		JSON.stringify(tba.json?.data?.skipped_tba),
	);
	const single = await cliJson(["check", a, "--json"]);
	check("check single id allowed", single.code === 0, `exit=${single.code}`);
	const block = await cliJson([
		"check",
		a,
		"--block",
		"MWF 10:00-11:00",
		"--json",
	]);
	check(
		"check block augment listed",
		(block.json?.data?.checked ?? []).some((id) => id.startsWith("BLOCK ")),
		JSON.stringify(block.json?.data?.checked),
	);
	check(
		"check block is not a seat problem",
		(block.json?.data?.seat_problems ?? []).every(
			(s) => !s.id.startsWith("BLOCK "),
		),
	);
	const badBlock = await cliJson([
		"check",
		a,
		"--block",
		"sometime maybe",
		"--json",
	]);
	check("check bad block exit 2", badBlock.code === 2, `exit=${badBlock.code}`);
	const crossTerm = await cliJson([
		"check",
		"CSCI 005 HM-01 FA2026",
		"ECON 050 SC-01 SP2026",
		"--json",
	]);
	check(
		"check cross-term exit 2",
		crossTerm.code === 2,
		`exit=${crossTerm.code}`,
	);
}
{
	const t = await cliJson(["history", "ECON 50", "--json"]);
	check(
		"history states observed window",
		(t.json?.data?.verdict ?? "").includes("Fall-only") &&
			(t.json?.data?.rotation_note ?? "").includes("Fall 2025–Fall 2026"),
		t.json?.data?.verdict,
	);
	check(
		"history enrichment provenance",
		t.json?.data?.enrichment?.term === FA2026,
		JSON.stringify(t.json?.data?.enrichment),
	);
	const multi = await cliJson(["history", "CSCI 50", "--json"]);
	check(
		"history multi-campus defers verdict",
		(multi.json?.data?.verdict ?? "").includes("specify a school"),
		multi.json?.data?.verdict,
	);
	const none = await cliJson(["history", "BLARG 999", "--json"]);
	check(
		"history nonsense is empty, exit 0",
		none.code === 0 && (none.json?.data?.offerings ?? []).length === 0,
	);
}
{
	const t = await cliJson(["refresh", "--term", FA2026, "--json"]);
	check("refresh exit 0", t.code === 0, `exit=${t.code}`);
	check(
		"refresh reports fixture count + quarantine",
		t.json?.data?.count === 12 && t.json?.data?.quarantined === 1,
		JSON.stringify({ c: t.json?.data?.count, q: t.json?.data?.quarantined }),
	);
	const forced = await cliJson([
		"refresh",
		"--term",
		FA2026,
		"--force",
		"--json",
	]);
	check("refresh --force exit 0", forced.code === 0);
}
{
	// Usage errors: exit 2 + JSON envelope, no fetch.
	const cases = [
		["search", "--limit", "99", "--json"],
		["search", "--limit", "2junk", "--json"],
		["search", "--sort", "bogus", "--json"],
		["search", "--days", "XX", "--term", FA2026, "--json"],
		["search", "--after", "notatime", "--term", FA2026, "--json"],
		["search", "--credits", "bogus", "--term", FA2026, "--json"],
		["search", "--bogus-opt-xyz", "--json"],
		["search", "--instructor", "--limit", "5", "--json"],
	];
	for (const args of cases) {
		const before = fixture.requests.length;
		const t = await cliJson(args);
		check(
			`usage ${args.slice(0, 3).join(" ")} exit 2`,
			t.code === 2 && t.json?.ok === false,
			`exit=${t.code}`,
		);
		if (args.includes("--term") || args.includes("FA2026")) {
			check(
				`usage ${args.join(" ")} offline`,
				fixture.requests.length === before,
				`${fixture.requests.length - before} request(s)`,
			);
		}
	}
}
{
	// Unpublished term: error by default, opt-in fallback with a warning.
	const strict = await cliJson([
		"search",
		"test",
		"--term",
		UNPUBLISHED_TERM,
		"--json",
	]);
	check("unpublished term exit 2", strict.code === 2, `exit=${strict.code}`);
	check(
		"unpublished term names available terms",
		(strict.json?.error?.hint ?? "").includes(FA2026),
		strict.json?.error?.hint,
	);
	const opted = await cliJson([
		"search",
		"test",
		"--term",
		UNPUBLISHED_TERM,
		"--fallback-term",
		"--json",
	]);
	check(
		"fallback opt-in serves newest + warns",
		opted.code === 0 &&
			opted.json?.data?.term === FA2026 &&
			(opted.json?.warnings ?? []).some((w) => w.includes(UNPUBLISHED_TERM)),
		JSON.stringify(opted.json?.warnings),
	);
	const bad = await cliJson([
		"search",
		"test",
		"--term",
		"next semester",
		"--json",
	]);
	check(
		"E_BAD_TERM exit 2",
		bad.code === 2 && bad.json?.error?.code === "E_BAD_TERM",
	);
}
{
	// Conflict exclusion: anchors must resolve exactly.
	const base = await cliJson([
		"search",
		"--dept",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--limit",
		"50",
	]);
	const excl = await cliJson([
		"search",
		"--dept",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--limit",
		"50",
		"--exclude-conflicts-with",
		"CSCI 005 HM-01 FA2026",
	]);
	check("exclusion exit 0", excl.code === 0);
	check(
		"exclusion drops anchor",
		!(excl.json?.data?.hits ?? []).some(
			(h) => h.id === "CSCI 005 HM-01 FA2026",
		),
	);
	const unknown = await cliJson([
		"search",
		"--dept",
		"CSCI",
		"--term",
		FA2026,
		"--json",
		"--exclude-conflicts-with",
		"NOPE 000 XX-01 FA2026",
	]);
	check(
		"unknown anchor exit 3",
		unknown.code === 3 && unknown.json?.error?.code === "E_NOT_FOUND",
		`exit=${unknown.code}`,
	);
}
{
	const help = await cli(["search", "--help"]);
	check(
		"flag name is --exclude-conflicts-with",
		help.stdout.includes("--exclude-conflicts-with"),
	);
	check(
		"help documents --fallback-term",
		help.stdout.includes("--fallback-term"),
	);
}
{
	// Warm perf budget.
	const t = await cliJson([
		"search",
		"test",
		"--term",
		FA2026,
		"--json",
		"--limit",
		"1",
	]);
	timings.search_warm_ms = t.ms;
	check("warm search < 1500ms", t.ms < 1500, `${t.ms}ms`);
}
{
	// Concurrency: parallel refreshes and searches against one cache dir.
	const dir = mkdtempSync(join(tmpdir(), "5c-e2e-stress-"));
	const stressEnv = { ...ENV, FIVE_C_DATA_DIR: dir };
	const refreshes = await Promise.all(
		Array.from({ length: 10 }, () =>
			cliJson(["refresh", "--term", FA2026, "--json"], stressEnv),
		),
	);
	check(
		"stress refresh x10 exit 0",
		refreshes.every((r) => r.code === 0),
		refreshes.map((r) => r.code).join(","),
	);
	check(
		"stress refresh counts agree",
		new Set(refreshes.map((r) => r.json?.data?.count)).size === 1,
		JSON.stringify(refreshes.map((r) => r.json?.data?.count)),
	);
	const searches = await Promise.all(
		Array.from({ length: 10 }, () =>
			cliJson(
				["search", "--dept", "CSCI", "--term", FA2026, "--json"],
				stressEnv,
			),
		),
	);
	check(
		"stress search x10 identical",
		new Set(searches.map((r) => r.json?.data?.total)).size === 1 &&
			new Set(searches.map((r) => r.json?.data?.hits?.[0]?.id)).size === 1,
		JSON.stringify(searches.map((r) => r.json?.data?.total)),
	);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------- MCP stdio ----------------
console.log("== MCP stdio ==");
{
	const mcp = mcpStdio();
	await mcp.initialize();
	const tools = await mcp.listTools();
	check("mcp 5 tools", tools.length === 5, `${tools.length}`);
	check(
		"mcp read-only + open-world annotations",
		tools.every(
			(t) =>
				t.annotations?.readOnlyHint === true &&
				t.annotations?.openWorldHint === true,
		),
	);
	check(
		"mcp every tool declares an outputSchema",
		tools.every(
			(t) =>
				t.outputSchema &&
				Object.keys(t.outputSchema.properties ?? {}).length > 0,
		),
	);
	const sc = tools.find((t) => t.name === "search_classes");
	check(
		"mcp strict input schema",
		sc?.inputSchema?.additionalProperties === false,
	);
	check(
		"mcp joint schools enum",
		(sc?.inputSchema?.properties?.schools?.items?.enum ?? []).includes("KS"),
	);
	check(
		"mcp weekend days enum",
		(sc?.inputSchema?.properties?.days?.items?.enum ?? []).includes("U"),
	);
	mcp.close();
}
{
	const mcp = mcpStdio();
	await mcp.initialize();
	const search = await mcp.call("search_classes", {
		query: "CSCI 5",
		term: FA2026,
		limit: 2,
	});
	check(
		"mcp search first hit",
		search?.structuredContent?.hits?.[0]?.id === "CSCI 005 HM-01 FA2026",
		JSON.stringify(search?.structuredContent?.hits?.[0]?.id),
	);
	check(
		"mcp search text carries provenance",
		textOf(search).includes("Seats as of"),
	);
	const get = await mcp.call("get_classes", {
		ids: ["BIOL 040 PO-01 FA2026"],
	});
	check(
		"mcp get returns both blocks",
		get?.structuredContent?.classes?.[0]?.meetings?.length === 2,
	);
	const ambiguous = await mcp.call("get_classes", {
		ids: ["CSCI 50"],
		term: FA2026,
	});
	check(
		"mcp get ambiguity reported",
		(ambiguous?.structuredContent?.ambiguous ?? []).length === 1 &&
			textOf(ambiguous).includes("AMBIGUOUS"),
	);
	const checkRes = await mcp.call("check_schedule", {
		ids: ["CSCI 005 HM-01 FA2026", "BIOL 040 PO-01 FA2026"],
	});
	check(
		"mcp check reports conflict + incomplete-free verdict",
		checkRes?.structuredContent?.ok === false &&
			checkRes?.structuredContent?.complete === true,
	);
	const tbaRes = await mcp.call("check_schedule", {
		ids: ["HIST 100 PO-01 FA2026", "CSCI 005 HM-01 FA2026"],
	});
	check(
		"mcp check flags incomplete audit",
		tbaRes?.structuredContent?.complete === false &&
			textOf(tbaRes).includes("audit INCOMPLETE"),
	);
	const terms = await mcp.call("list_terms", {});
	check("mcp terms current", terms?.structuredContent?.current_term === FA2026);
	const history = await mcp.call("get_course_history", { code: "ECON 50" });
	check(
		"mcp history verdict + window",
		(history?.structuredContent?.verdict ?? "").includes("Fall-only"),
		history?.structuredContent?.verdict,
	);
	const strict = await mcp.call("search_classes", {
		query: "CSCI",
		term: FA2026,
		open_only: true,
	});
	check(
		"mcp unknown param rejected by name",
		strict?.isError === true && textOf(strict).includes("open_only"),
		textOf(strict).slice(0, 120),
	);
	const fallback = await mcp.call("search_classes", {
		term: UNPUBLISHED_TERM,
	});
	check(
		"mcp unpublished term is an error",
		fallback?.isError === true && textOf(fallback).includes("E_TERM_NOT_FOUND"),
		textOf(fallback).slice(0, 140),
	);
	mcp.close();
}

// ---------------- MCP http ----------------
console.log("== MCP http ==");
{
	const child = spawn(process.execPath, [MCP, "--http", "--port", "0"], {
		env: ENV,
	});
	let stderr = "";
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("http server never listened")),
			15000,
		);
		child.stderr.on("data", (d) => {
			stderr += d.toString();
			const m = stderr.match(/on (http:\/\/[^\s]+)/);
			if (m) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
	});
	let url;
	try {
		url = await ready;
	} catch (err) {
		check("http server starts", false, String(err));
	}
	if (url) {
		check("http binds localhost", url.startsWith("http://127.0.0.1:"), url);
		const post = async (body) => {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(body),
			});
			return res.text();
		};
		const init = await post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "e2e", version: "0" },
			},
		});
		check("http initialize", init.includes("5c-index"), init.slice(0, 120));
		const callOne = await post({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "list_terms", arguments: {} },
		});
		check(
			"http tools/call #1",
			callOne.includes(FA2026),
			callOne.slice(0, 120),
		);
		const callTwo = await post({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "search_classes",
				arguments: { query: "CSCI", term: FA2026, limit: 1 },
			},
		});
		check(
			"http tools/call #2 (stateless, no Already-connected)",
			callTwo.includes("CSCI 005 HM-01 FA2026") &&
				!callTwo.includes("Already connected"),
			callTwo.slice(0, 160),
		);
		const wrongMethod = await fetch(url, { method: "GET" });
		check(
			"http rejects non-POST",
			wrongMethod.status === 405,
			`status=${wrongMethod.status}`,
		);
	}
	try {
		child.kill();
	} catch {}
}

// ---------------- skill ----------------
console.log("== skill ==");
{
	const raw = readFileSync(join(ROOT, "skills/5c-classes/SKILL.md"), "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---/);
	check("skill frontmatter", !!m);
	const fm = m?.[1] ?? "";
	const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
	const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
	check("skill name == dir", name === "5c-classes", name);
	check(
		"skill desc length",
		desc.length >= 1 && desc.length <= 1024,
		`${desc.length}`,
	);
	const allowed = new Set([
		"name",
		"description",
		"license",
		"compatibility",
		"metadata",
		"author",
		"version",
	]);
	const topKeys = [...fm.matchAll(/^([a-z-]+):\s/gm)].map((x) => x[1]);
	check(
		"skill keys spec-safe",
		topKeys.every((k) => allowed.has(k)),
		topKeys.join(","),
	);
	check("skill <500 lines", raw.split("\n").length < 500);
	const skillText = [
		raw,
		...["search-syntax.md", "ids-and-terms.md", "troubleshooting.md"].map((f) =>
			readFileSync(join(ROOT, "skills/5c-classes/references", f), "utf8"),
		),
	].join("\n");
	for (const ref of [
		"references/search-syntax.md",
		"references/ids-and-terms.md",
		"references/troubleshooting.md",
	]) {
		try {
			readFileSync(join(ROOT, "skills/5c-classes", ref), "utf8");
			check(`skill ref ${ref}`, true);
		} catch {
			check(`skill ref ${ref}`, false);
		}
	}
	const evals = JSON.parse(
		readFileSync(join(ROOT, "skills/5c-classes/evals/tool-paths.json"), "utf8"),
	);
	check(
		"skill evals intact + extended",
		evals.length >= 18 && evals.every((e) => Array.isArray(e.path)),
		`${evals.length}`,
	);
	// Doc lint: flags the skill cites must exist in the CLI's own catalog.
	const catalog = (await cliJson(["schema", "--json"])).json?.data;
	const knownFlags = new Set([
		"--json",
		"--format",
		"--no-color",
		"--non-interactive",
		"--help",
		"--version",
	]);
	for (const c of catalog?.commands ?? []) {
		for (const f of c.flags ?? []) knownFlags.add(`--${f.name}`);
	}
	const referencedFlags = [
		...new Set([...skillText.matchAll(/--[a-z][a-z-]+/g)].map((x) => x[0])),
	];
	const unknownFlags = referencedFlags.filter((f) => !knownFlags.has(f));
	check(
		"skill cites only real flags",
		unknownFlags.length === 0,
		unknownFlags.join(","),
	);
	check(
		"skill uses the wire field name potential_error",
		skillText.includes("potential_error"),
	);
}

// ---------------- live suite ----------------
if (LIVE) {
	console.log("== LIVE (network) ==");
	const liveRun = (args) => cliJson(args, LIVE_ENV);
	const ver = await liveRun(["version", "--json"]);
	check("live version exit 0", ver.code === 0);
	const refreshed = await liveRun(["refresh", "--term", "FA2026", "--json"]);
	check(
		"live refresh exit 0 with a real catalog",
		refreshed.code === 0 && (refreshed.json?.data?.count ?? 0) > 500,
		JSON.stringify({
			exit: refreshed.code,
			count: refreshed.json?.data?.count,
		}),
	);
	const calc = await liveRun([
		"search",
		"calculus",
		"--term",
		"FA2026",
		"--json",
		"--limit",
		"3",
	]);
	check(
		"live search returns hits",
		calc.code === 0 && (calc.json?.data?.total ?? 0) > 0,
		JSON.stringify({ exit: calc.code, total: calc.json?.data?.total }),
	);

	const rel = JSON.parse(
		readFileSync(join(ROOT, "tests/evals/relevance-50.json"), "utf8"),
	);
	const FLAGMAP = {
		school: "--school",
		dept: "--dept",
		days: "--days",
		after: "--after",
		before: "--before",
		instructor: "--instructor",
		area: "--area",
		credits: "--credits",
		code: "--code",
	};
	let relPass = 0;
	for (const e of rel) {
		const args = ["search"];
		if (e.query) args.push(e.query);
		for (const [k, v] of Object.entries(e.filters ?? {})) {
			if (k === "open") {
				if (v) args.push("--open");
				continue;
			}
			args.push(FLAGMAP[k] ?? `--${k}`, String(v));
		}
		args.push("--term", e.term ?? "FA2026", "--json", "--limit", "3");
		const r = await liveRun(args);
		const top = r.json?.data?.hits?.[0]?.id ?? null;
		const total = r.json?.data?.total ?? -1;
		const okTop =
			e.expect_top === null
				? top === null
				: top === e.expect_top || (e.accept_any_of ?? []).includes(top);
		const okTotal =
			e.expect_total === undefined || e.expect_total === null
				? true
				: total === e.expect_total;
		if (okTop && okTotal && r.code === 0) relPass++;
		else
			check(
				`relevance #${e.id} ${JSON.stringify(e.query ?? e.filters)}`,
				false,
				`top=${top} total=${total} (exp ${e.expect_top}/${e.expect_total ?? "-"})`,
			);
	}
	check(
		"relevance-50 all pass",
		relPass === rel.length,
		`${relPass}/${rel.length}`,
	);
} else {
	console.log("(live suite skipped: pass --live or FIVE_C_LIVE=1)");
}

// ---------------- report ----------------
await fixture.close();
rmSync(CACHE, { recursive: true, force: true });
console.log(`\ne2e: ${passed} passed, ${failed} failed`);
console.log(
	`perf: cold ${timings.search_cold_ms ?? -1}ms, warm ${timings.search_warm_ms ?? -1}ms`,
);
if (failed > 0) {
	console.log(`failures:\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log("E2E GREEN");
