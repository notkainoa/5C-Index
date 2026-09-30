import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FA2026,
	type FixtureServer,
	UNPUBLISHED_TERM,
	startFixtureServer,
} from "../../../tests/fixture-server.mjs";
import {
	checkOutputSchema,
	getOutputSchema,
	historyOutputSchema,
	searchOutputSchema,
	termsOutputSchema,
} from "../src/schemas.js";
import { createMcpServer, isDirectRun } from "../src/server.js";

/**
 * MCP contract tests. Real HTTP against a fixture upstream (no network), the
 * real SDK transport pair, and assertions on BOTH the text a host shows and
 * the structuredContent it passes on — plus explicit re-validation against the
 * advertised output schemas, so the suite still proves the contract even if
 * the SDK ever validates less than we think it does.
 */

interface ToolResult {
	content: { type: string; text?: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	isValid?: boolean;
}

interface ToolListing {
	name: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

let fixture: FixtureServer;
let client: Client;
let dataDir: string;
const savedEnv = {
	apiBase: process.env.FIVE_C_API_BASE,
	dataDir: process.env.FIVE_C_DATA_DIR,
};

function restoreEnv(): void {
	// Assigning undefined would stringify to "undefined", so put back either
	// the original value or nothing at all.
	// biome-ignore lint/performance/noDelete: removing the key is the point
	if (savedEnv.apiBase === undefined) delete process.env.FIVE_C_API_BASE;
	else process.env.FIVE_C_API_BASE = savedEnv.apiBase;
	// biome-ignore lint/performance/noDelete: removing the key is the point
	if (savedEnv.dataDir === undefined) delete process.env.FIVE_C_DATA_DIR;
	else process.env.FIVE_C_DATA_DIR = savedEnv.dataDir;
}

beforeAll(async () => {
	fixture = await startFixtureServer();
	dataDir = await mkdtemp(join(tmpdir(), "5c-mcp-"));
	process.env.FIVE_C_API_BASE = fixture.url;
	process.env.FIVE_C_DATA_DIR = dataDir;

	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	client = new Client({ name: "5c-contract", version: "0.0.0" });
	await Promise.all([
		client.connect(clientTransport),
		createMcpServer().connect(serverTransport),
	]);
});

afterAll(async () => {
	await client.close();
	await fixture.close();
	await rm(dataDir, { recursive: true, force: true });
	restoreEnv();
});

async function call(
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function text(res: ToolResult): string {
	return res.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("tool listing", () => {
	it("advertises an output schema and network annotations for every tool", async () => {
		const { tools } = (await client.listTools()) as { tools: ToolListing[] };
		expect(tools.map((t) => t.name).sort()).toEqual([
			"check_schedule",
			"get_classes",
			"get_course_history",
			"list_terms",
			"search_classes",
		]);
		for (const tool of tools) {
			expect(tool.outputSchema, `${tool.name} outputSchema`).toBeTruthy();
			expect(
				Object.keys(tool.outputSchema?.properties ?? {}).length,
				`${tool.name} output properties`,
			).toBeGreaterThan(0);
			// Every tool reads an external upstream, so openWorldHint must be true.
			expect(tool.annotations?.openWorldHint, `${tool.name}`).toBe(true);
			expect(tool.annotations?.readOnlyHint, `${tool.name}`).toBe(true);
		}
	});

	it("rejects unknown parameters instead of ignoring them", async () => {
		const res = await call("search_classes", { open_only: true });
		expect(res.isError).toBe(true);
		expect(text(res)).toMatch(/Unrecognized key/i);
	});

	it("does not start a server on import", () => {
		expect(isDirectRun).toBe(false);
	});
});

describe("search_classes", () => {
	it("returns hits that satisfy both the SDK and the advertised schema", async () => {
		const res = await call("search_classes", { departments: ["CSCI"] });
		expect(res.isError).toBeFalsy();
		const parsed = searchOutputSchema.safeParse(res.structuredContent);
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
		const body = parsed.data as {
			term: string;
			total_count: number;
			hits: { id: string }[];
			snapshot_id: string | null;
			quarantined: number;
			stale: boolean;
		};
		expect(body.term).toBe(FA2026);
		expect(body.total_count).toBe(3);
		expect(body.hits.map((h) => h.id).sort()).toEqual([
			"CSCI 005 HM-01 FA2026",
			"CSCI 050 PO-01 FA2026",
			"CSCI 050 PO-02 FA2026",
		]);
		expect(body.snapshot_id).toBeTruthy();
		expect(body.stale).toBe(false);
	});

	it("reports partial ingest in text as well as JSON", async () => {
		const res = await call("search_classes", { departments: ["CSCI"] });
		const body = res.structuredContent as { quarantined: number };
		expect(body.quarantined).toBe(1);
		expect(text(res)).toContain("1 row(s) were dropped at ingest");
		expect(text(res)).toContain("Seats as of");
	});

	it("shows per-block meeting times and flags unreliable source data", async () => {
		const res = await call("search_classes", {
			departments: ["BIOL", "PHYS"],
		});
		const t = text(res);
		// BIOL 40 has two blocks; both must be visible, not merged into one.
		expect(t).toContain("TR 09:35-10:50");
		expect(t).toContain("M 13:15-17:00");
		expect(t).toContain("[source data flagged]");
	});

	it("treats availability as registrar status, not seat arithmetic", async () => {
		const any = await call("search_classes", { departments: ["BIOL"] });
		expect((any.structuredContent as { total_count: number }).total_count).toBe(
			1,
		);
		const open = await call("search_classes", {
			departments: ["BIOL"],
			availability: "has_seat",
		});
		const body = open.structuredContent as {
			total_count: number;
			hint: string;
		};
		expect(body.total_count).toBe(0);
		expect(body.hint).toBeTruthy();
	});

	it("errors on an unpublished term, and serves one only when asked", async () => {
		const strict = await call("search_classes", { term: UNPUBLISHED_TERM });
		expect(strict.isError).toBe(true);
		expect(text(strict)).toMatch(/list_terms/);

		const opted = await call("search_classes", {
			term: UNPUBLISHED_TERM,
			allow_term_fallback: true,
		});
		expect(opted.isError).toBeFalsy();
		const body = opted.structuredContent as {
			term: string;
			fallback?: { requested: string; served: string };
		};
		expect(body.term).toBe(FA2026);
		expect(body.fallback).toEqual({
			requested: UNPUBLISHED_TERM,
			served: FA2026,
		});
		expect(text(opted)).toContain(`${UNPUBLISHED_TERM} is not published`);
	});
});

describe("get_classes", () => {
	it("expands an exact ID with meetings, seats, and dates", async () => {
		const res = await call("get_classes", {
			ids: ["BIOL 040 PO-01 FA2026"],
		});
		expect(res.isError).toBeFalsy();
		const parsed = getOutputSchema.safeParse(res.structuredContent);
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
		const t = text(res);
		expect(t).toContain("BIOL 040 PO-01 FA2026");
		expect(t).toContain("TR 9:35 AM–10:50 AM");
		expect(t).toContain("M 1:15 PM–5:00 PM");
		expect(t).toContain("Seats: 0 open");
	});

	it("reports garbage IDs as not_found with close matches, and errors", async () => {
		const res = await call("get_classes", {
			ids: ["garbage"],
			term: FA2026,
		});
		expect(res.isError).toBe(true);
		const body = res.structuredContent as {
			not_found: string[];
			classes: unknown[];
		};
		expect(body.classes).toHaveLength(0);
		expect(body.not_found).toEqual(["garbage"]);
		expect(text(res)).toContain("NOT FOUND: garbage");
	});

	it("returns candidates instead of guessing for a loose ID", async () => {
		const res = await call("get_classes", { ids: ["CSCI 50"], term: FA2026 });
		const body = res.structuredContent as {
			ambiguous: { input: string; section_ids: string[] }[];
		};
		expect(body.ambiguous).toHaveLength(1);
		expect(body.ambiguous[0]?.section_ids.sort()).toEqual([
			"CSCI 050 PO-01 FA2026",
			"CSCI 050 PO-02 FA2026",
		]);
		expect(text(res)).toContain("AMBIGUOUS");
	});

	it("surfaces TBA times and potential_error in detail output", async () => {
		const res = await call("get_classes", {
			ids: ["HIST 100 PO-01 FA2026", "PHYS 070 HM-01 FA2026"],
		});
		expect(res.isError).toBeFalsy();
		const body = res.structuredContent as {
			classes: { potentialError: boolean; meetings: unknown[] }[];
		};
		expect(body.classes).toHaveLength(2);
		expect(body.classes.some((c) => c.potentialError)).toBe(true);
		expect(body.classes.some((c) => c.meetings.length === 0)).toBe(true);
		const t = text(res);
		expect(t).toContain("Meets: TBA");
		expect(t).toContain("flagged unreliable");
	});
});

describe("check_schedule", () => {
	it("reports conflicts, closed sections, and a truthful verdict", async () => {
		const res = await call("check_schedule", {
			ids: ["CSCI 005 HM-01 FA2026", "BIOL 040 PO-01 FA2026"],
		});
		const parsed = checkOutputSchema.safeParse(res.structuredContent);
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
		const body = parsed.data as {
			ok: boolean;
			complete: boolean;
			conflicts: { severity: string }[];
			seat_problems: { id: string; reason: string }[];
		};
		expect(body.ok).toBe(false);
		expect(body.conflicts.length).toBeGreaterThan(0);
		expect(body.seat_problems.map((s) => s.id)).toContain(
			"BIOL 040 PO-01 FA2026",
		);
		expect(text(res)).toMatch(/NOT OK/);
		expect(text(res)).toMatch(/Closed by registrar|No remaining capacity/);
	});

	it("never claims a complete audit when TBA times were skipped", async () => {
		const res = await call("check_schedule", {
			ids: ["HIST 100 PO-01 FA2026", "CSCI 005 HM-01 FA2026"],
		});
		const body = res.structuredContent as {
			ok: boolean;
			complete: boolean;
			skipped_tba: string[];
		};
		expect(body.ok).toBe(true);
		expect(body.complete).toBe(false);
		expect(body.skipped_tba).toEqual(["HIST 100 PO-01 FA2026"]);
		expect(text(res)).toContain("audit INCOMPLETE");
		expect(text(res)).toContain("absence of evidence");
	});

	it("requires exact IDs and says which ones failed", async () => {
		const res = await call("check_schedule", {
			ids: ["CSCI 50"],
			term: FA2026,
		});
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("E_NOT_FOUND");
		expect(text(res)).toContain("CSCI 50");
	});

	it("refuses to compare sections from different terms", async () => {
		const res = await call("check_schedule", {
			ids: ["CSCI 005 HM-01 FA2026", "ECON 050 SC-01 SP2026"],
		});
		expect(res.isError).toBe(true);
		expect(text(res)).toMatch(/term-scoped|span/i);
	});
});

describe("list_terms", () => {
	it("lists terms with the current one flagged", async () => {
		const res = await call("list_terms", {});
		const parsed = termsOutputSchema.safeParse(res.structuredContent);
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
		const body = parsed.data as {
			current_term: string;
			terms: { code: string; is_current: boolean }[];
		};
		expect(body.current_term).toBe(FA2026);
		expect(body.terms[0]?.code).toBe(FA2026);
		expect(body.terms[0]?.is_current).toBe(true);
		expect(text(res)).toContain("Current: FA2026");
	});
});

describe("get_course_history", () => {
	it("defers a per-course verdict when campuses have separate histories", async () => {
		const res = await call("get_course_history", { code: "CSCI 50" });
		const parsed = historyOutputSchema.safeParse(res.structuredContent);
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
		const body = parsed.data as {
			verdict: string;
			offerings: { campus: string }[];
		};
		expect(body.verdict).toMatch(/specify a school/i);
		expect(new Set(body.offerings.map((o) => o.campus))).toContain("PO");
		expect(text(res)).toMatch(/specify a school/i);
	});

	it("states the window it observed and enriches seats per term", async () => {
		const res = await call("get_course_history", { code: "ECON 50" });
		const body = res.structuredContent as {
			verdict: string;
			rotation_note: string;
			offerings: { term: string; seats: unknown }[];
			fetched_at: string;
		};
		expect(body.verdict).toMatch(/Fall-only/);
		expect(body.rotation_note).toContain("Fall 2025–Fall 2026");
		expect(body.offerings.map((o) => o.term)).toEqual(["FA2026", "FA2025"]);
		expect(body.offerings[0]?.seats).toBeTruthy();
		expect(body.offerings[1]?.seats).toBeNull();
		expect(body.fetched_at).toBeTruthy();
		expect(text(res)).toContain("History as of");
	});
});
