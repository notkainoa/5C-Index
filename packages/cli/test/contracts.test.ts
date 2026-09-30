import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FA2026,
	type FixtureServer,
	startFixtureServer,
} from "../../../tests/fixture-server.mjs";

/**
 * CLI contract tests, end to end: the built binary, a real fixture upstream,
 * a temp cache dir, no network. Every assertion is on the JSON envelope, the
 * exit code, or the rendered text — the three surfaces agents actually read.
 */

const exec = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const CLI = join(packageRoot, "dist", "index.js");

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

let fixture: FixtureServer;
let dataDir: string;

/**
 * Run the built CLI. `cli()` never fetches; every fetchable command points at
 * the fixture upstream.
 */
async function cli(
	args: string[],
	env: Record<string, string> = {},
): Promise<Result> {
	const childEnv: Record<string, string> = {
		...process.env,
		FIVE_C_API_BASE: fixture.url,
		FIVE_C_DATA_DIR: dataDir,
		NO_COLOR: "1",
		...env,
	} as Record<string, string>;
	try {
		const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
			env: childEnv,
			timeout: 20000,
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		};
	}
}

/** Parse the single JSON document the CLI writes to stdout. */
function json(res: Result): {
	ok: boolean;
	command: string;
	data: Record<string, unknown>;
	meta: Record<string, unknown>;
	next: string[];
	warnings: string[];
	error?: { code: string; message: string; hint: string | null };
} {
	return JSON.parse(res.stdout);
}

beforeAll(async () => {
	fixture = await startFixtureServer();
	dataDir = await mkdtemp(join(tmpdir(), "5c-cli-"));
	// The binary under test must be the current source, not a stale dist.
	await exec("pnpm", ["run", "build"], {
		cwd: join(repoRoot, "packages", "core"),
	});
	await exec("pnpm", ["run", "build"], { cwd: packageRoot });
}, 120000);

afterAll(async () => {
	await fixture.close();
	await rm(dataDir, { recursive: true, force: true });
});

function search(dept: string, extra: string[] = []): Promise<Result> {
	return cli(["search", "--json", "--dept", dept, ...extra]);
}

describe("search", () => {
	it("emits the JSON envelope with hits, provenance, and snapshot identity", async () => {
		const res = await search("CSCI");
		expect(res.code).toBe(0);
		const body = json(res);
		expect(body.ok).toBe(true);
		expect(body.command).toBe("search");
		const data = body.data as {
			term: string;
			total: number;
			hits: { id: string; meetings: unknown[]; credits: number }[];
			snapshot_id: string;
		};
		expect(data.term).toBe(FA2026);
		expect(data.total).toBe(3);
		expect(data.hits.map((h) => h.id).sort()).toEqual([
			"CSCI 005 HM-01 FA2026",
			"CSCI 050 PO-01 FA2026",
			"CSCI 050 PO-02 FA2026",
		]);
		expect(data.hits[0]?.meetings.length).toBeGreaterThan(0);
		expect(typeof data.hits[0]?.credits).toBe("number");
		expect(typeof data.snapshot_id).toBe("string");
		expect(typeof body.meta.fetched_at).toBe("string");
		expect(body.meta.normalized).toBeTruthy();
	});

	it("renders a table and a hint block in --format table", async () => {
		const res = await cli(["search", "--format", "table", "--dept", "CSCI"]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("ID");
		expect(res.stdout).toContain("CSCI 005 HM-01 FA2026");
		expect(res.stderr).toContain("3 hits (term FA2026");
		expect(res.stderr).toContain("ST: O=open C=closed R=reopened U=unknown.");
	});

	it("reports partial ingest as a warning, not a silent success", async () => {
		const body = json(await search("CSCI"));
		expect(body.meta.quarantined).toBe(1);
		expect(body.warnings.join(" ")).toContain("ingest dropped 1 row");
	});

	it("exits 2 on a malformed limit without touching the network", async () => {
		const before = fixture.requests.length;
		const res = await cli(["search", "--json", "--limit", "2junk"]);
		expect(res.code).toBe(2);
		expect(json(res).error?.code).toBe("E_USAGE");
		expect(fixture.requests.length).toBe(before);
	});

	it("exits 2 when a value-taking flag swallows another flag", async () => {
		const res = await cli(["search", "--json", "--instructor", "--limit", "5"]);
		expect(res.code).toBe(2);
		expect(json(res).error?.code).toBe("E_USAGE");
	});

	it("exits 2 on an unknown --format", async () => {
		const res = await cli([
			"search",
			"--json",
			"--format",
			"yaml",
			"--dept",
			"CSCI",
		]);
		expect(res.code).toBe(2);
		expect(json(res).error?.code).toBe("E_USAGE");
	});

	it("exits 2 on an unpublished term and lists available ones", async () => {
		const res = await cli(["search", "--json", "--term", "SP2099"]);
		expect(res.code).toBe(2);
		const body = json(res);
		expect(body.error?.code).toBe("E_BAD_TERM");
		expect(body.error?.hint).toContain("FA2026");
	});

	it("serves the newest term only when --fallback-term is passed", async () => {
		const res = await cli([
			"search",
			"--json",
			"--term",
			"SP2099",
			"--fallback-term",
			"--dept",
			"CSCI",
		]);
		expect(res.code).toBe(0);
		const body = json(res);
		expect((body.data as { term: string }).term).toBe(FA2026);
		expect(body.warnings.join(" ")).toContain("SP2099 is not published");
	});

	it("drops closed-but-spare sections only for --open", async () => {
		const all = json(await search("BIOL")).data as { total: number };
		expect(all.total).toBe(1);
		const open = json(await search("BIOL", ["--open"])).data as {
			total: number;
			hint: string;
		};
		expect(open.total).toBe(0);
		expect(open.hint).toBeTruthy();
	});

	it("treats --code digit count as course vs family", async () => {
		const family = json(await search("", ["--code", "CSCI 05"])).data as {
			hits: { id: string }[];
		};
		expect(family.hits.map((h) => h.id).sort()).toEqual([
			"CSCI 050 PO-01 FA2026",
			"CSCI 050 PO-02 FA2026",
		]);
		const exact = json(await search("", ["--code", "CSCI 5"])).data as {
			hits: { id: string }[];
		};
		expect(exact.hits.map((h) => h.id)).toEqual(["CSCI 005 HM-01 FA2026"]);
	});

	it("says when an offset is past the end instead of pretending empty", async () => {
		const data = json(await search("CSCI", ["--offset", "99"])).data as {
			hint: string;
			total: number;
		};
		expect(data.total).toBe(3);
		expect(data.hint).toContain("past the end");
	});
});

describe("get", () => {
	it("returns full detail with all meeting blocks", async () => {
		const res = await cli(["get", "BIOL 040 PO-01 FA2026", "--json"]);
		expect(res.code).toBe(0);
		const body = json(res);
		const data = body.data as {
			id: string;
			meetings: { days: string[]; start12: string }[];
			seats: { available: number; total: number };
		};
		expect(data.id).toBe("BIOL 040 PO-01 FA2026");
		expect(data.meetings).toHaveLength(2);
		expect(data.seats.total).toBe(26);
	});

	it("exits 3 with candidates for a loose ID, never guessing", async () => {
		const res = await cli(["get", "CSCI 50", "--term", FA2026, "--json"]);
		expect(res.code).toBe(3);
		const body = json(res);
		expect(body.error?.code).toBe("E_NOT_FOUND");
		expect(body.error?.message).toContain("Ambiguous");
		expect(
			(body.error as unknown as { did_you_mean: string[] }).did_you_mean.sort(),
		).toEqual(["CSCI 050 PO-01 FA2026", "CSCI 050 PO-02 FA2026"]);
	});

	it("reports garbage IDs as unknown with suggestions", async () => {
		const res = await cli(["get", "garbage", "--term", FA2026, "--json"]);
		expect(res.code).toBe(3);
		expect(json(res).error?.code).toBe("E_NOT_FOUND");
	});

	it("warns when source data is flagged unreliable", async () => {
		const res = await cli(["get", "PHYS 070 HM-01 FA2026", "--json"]);
		expect(res.code).toBe(0);
		expect(json(res).warnings.join(" ")).toContain("potential_error");
	});
});

describe("check", () => {
	it("reports conflicts and closed sections in one pass", async () => {
		const res = await cli([
			"check",
			"--json",
			"CSCI 005 HM-01 FA2026",
			"BIOL 040 PO-01 FA2026",
		]);
		expect(res.code).toBe(0);
		const data = json(res).data as {
			ok: boolean;
			complete: boolean;
			conflicts: { severity: string }[];
			seat_problems: { id: string; reason: string }[];
			checked: string[];
		};
		expect(data.ok).toBe(false);
		expect(data.conflicts.length).toBeGreaterThan(0);
		expect(data.seat_problems.map((s) => s.id)).toContain(
			"BIOL 040 PO-01 FA2026",
		);
		expect(data.checked).toEqual([
			"CSCI 005 HM-01 FA2026",
			"BIOL 040 PO-01 FA2026",
		]);
	});

	it("marks a TBA section as skipped rather than conflict-free", async () => {
		const res = await cli([
			"check",
			"--json",
			"HIST 100 PO-01 FA2026",
			"CSCI 005 HM-01 FA2026",
		]);
		const data = json(res).data as {
			ok: boolean;
			complete: boolean;
			skipped_tba: string[];
		};
		expect(data.ok).toBe(true);
		expect(data.complete).toBe(false);
		expect(data.skipped_tba).toEqual(["HIST 100 PO-01 FA2026"]);
	});

	it("augments with an ad-hoc block spanning the schedule's dates", async () => {
		const ok = await cli([
			"check",
			"--json",
			"CSCI 005 HM-01 FA2026",
			"--block",
			"MWF 10:00-11:00",
		]);
		expect(ok.code).toBe(0);
		const data = json(ok).data as {
			checked: string[];
			seat_problems: { id: string }[];
			ok: boolean;
		};
		expect(data.checked.some((id) => id.startsWith("BLOCK "))).toBe(true);
		// A synthetic block is not a class: it must never appear as a seat problem.
		expect(data.seat_problems.every((s) => !s.id.startsWith("BLOCK "))).toBe(
			true,
		);
	});

	it("exits 2 on a malformed block without fetching", async () => {
		const before = fixture.requests.length;
		const res = await cli(["check", "--json", "--block", "sometime maybe"]);
		expect(res.code).toBe(2);
		expect(json(res).error?.code).toBe("E_USAGE");
		expect(fixture.requests.length).toBe(before);
	});

	it("exits 2 on a bad --file payload", async () => {
		const res = await cli(["check", "--json", "--file", "/nonexistent.json"]);
		expect(res.code).toBe(2);
		expect(json(res).error?.code).toBe("E_USAGE");
	});

	it("rejects an unknown ID with exit 3 and names it", async () => {
		const res = await cli(["check", "--json", "CSCI 005 HM-01 FA2026", "nope"]);
		expect(res.code).toBe(3);
		const body = json(res);
		expect(body.error?.code).toBe("E_NOT_FOUND");
		expect(body.error?.message).toContain("nope");
	});

	it("rejects a batch over the cap instead of truncating it", async () => {
		const many = Array.from(
			{ length: 21 },
			(_, i) => `CSCI 005 HM-${i} FA2026`,
		);
		const res = await cli(["check", "--json", ...many]);
		expect(res.code).toBe(2);
		expect(json(res).error?.message).toContain("cap is 20");
	});
});

describe("terms, history, version, schema", () => {
	it("lists terms with the current one flagged", async () => {
		const res = await cli(["terms", "--json"]);
		expect(res.code).toBe(0);
		const data = json(res).data as {
			current: string;
			terms: { code: string; is_current: boolean }[];
		};
		expect(data.current).toBe(FA2026);
		expect(data.terms[0]?.is_current).toBe(true);
	});

	it("defers a history verdict when campuses differ, and states the window", async () => {
		const multi = json(await cli(["history", "CSCI 50", "--json"])).data as {
			verdict: string;
		};
		expect(multi.verdict).toMatch(/specify a school/i);

		const single = json(await cli(["history", "ECON 50", "--json"])).data as {
			verdict: string;
			rotation_note: string;
			enrichment: { term: string } | null;
			fetched_at: string;
		};
		expect(single.verdict).toMatch(/Fall-only/);
		expect(single.rotation_note).toContain("Fall 2025–Fall 2026");
		expect(single.enrichment?.term).toBe(FA2026);
		expect(single.fetched_at).toBeTruthy();
	});

	it("works offline: version never fetches", async () => {
		const before = fixture.requests.length;
		const res = await cli(["version", "--json"], {
			FIVE_C_API_BASE: "http://127.0.0.1:9",
		});
		expect(res.code).toBe(0);
		const data = json(res).data as { version: string };
		// version must match the package it ships in, not a hardcoded constant
		const pkg = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as { version: string };
		expect(data.version).toBe(pkg.version);
		expect(fixture.requests.length).toBe(before);
	});

	it("derives its schema catalog from the real command definitions", async () => {
		const res = await cli(["schema", "--json"]);
		expect(res.code).toBe(0);
		const catalog = json(res).data as {
			commands: {
				name: string;
				flags: { name: string }[];
				args: string[];
			}[];
			exit_codes: Record<string, string>;
		};
		const names = catalog.commands.map((c) => c.name);
		expect(names).toContain("search");
		expect(names).toContain("check");
		const search = catalog.commands.find((c) => c.name === "search");
		const flagNames = search?.flags.map((f) => f.name) ?? [];
		expect(flagNames).toContain("fallback-term");
		expect(flagNames).toContain("exclude-conflicts-with");
		expect(flagNames).not.toContain("open_only");
		expect(catalog.exit_codes["3"]).toContain("not-found");

		// Every advertised flag must exist in that command's own help text.
		for (const cmd of catalog.commands) {
			if (cmd.name === "help") continue;
			const help = await cli([cmd.name, "--help"]);
			for (const flag of cmd.flags) {
				expect(help.stdout, `${cmd.name} --${flag.name}`).toContain(
					`--${flag.name}`,
				);
			}
		}
	});

	it("projects requested hit fields and warns about unknown ones", async () => {
		const data = json(await search("CSCI", ["--fields", "id,title,nope"]));
		const hits = data.data.hits as Record<string, unknown>[];
		expect(Object.keys(hits[0] ?? {}).sort()).toEqual(["id", "title"]);
		expect(data.warnings.join(" ")).toContain("unknown --fields ignored: nope");
	});
});
