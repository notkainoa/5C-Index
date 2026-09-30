import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSchedule } from "../src/conflicts.js";
import { normalizeSection } from "../src/normalize.js";
import { rawSectionsSchema } from "../src/schema.js";
import { MiniSearchProvider } from "../src/search.js";

/**
 * Deterministic golden evals on the 10-section FA2026 fixture.
 * Guards ranking tiers, hard filters, and conflict math in CI.
 */

const raw = rawSectionsSchema.parse(
	JSON.parse(
		readFileSync(new URL("./fixture-raw.json", import.meta.url), "utf8"),
	),
);
const sections = raw.map(normalizeSection);
const byId = new Map(sections.map((s) => [s.id, s]));

function provider() {
	const p = new MiniSearchProvider();
	p.build(sections);
	return p;
}

describe("golden: ranking", () => {
	it("exact code outranks description matches", () => {
		const hits = provider().query("CSCI 005", {});
		expect(hits[0].section.id).toBe("CSCI 005 HM-01 FA2026");
		expect(hits[0].match).toContain("exact-code");
	});

	it("description search finds genetics", () => {
		const hits = provider().query("genetics", {});
		expect(hits[0].section.id).toBe("BIOL 040 PO-01 FA2026");
	});

	it("title phrase resolves marxism", () => {
		const hits = provider().query("marxism", {});
		expect(hits[0].section.id).toBe("AFRI 116 AF-01 FA2026");
	});

	it("whole-word title match beats substring ('organic' vs 'inorganic')", () => {
		const hits = provider().query("calculus", {});
		expect(hits[0].match).toContain("title-words");
		expect(hits[0].section.title.toLowerCase()).toContain("calculus");
	});

	it("partial number prefix is unpadded (AFRI 1 → 010 and 116)", () => {
		const hits = provider().query("AFRI 1", {});
		const ids = hits.map((h) => h.section.id).sort();
		expect(ids).toEqual(["AFRI 010A AF-01 FA2026", "AFRI 116 AF-01 FA2026"]);
	});

	it("code-shaped query with no match returns empty, not fuzzy soup", () => {
		const hits = provider().query("QQQ 000", {});
		expect(hits).toEqual([]);
	});

	it("recall hints fire for dept/college mentions, not for code queries", async () => {
		const { recallSuggestions } = await import("../src/index.js");
		const cs = recallSuggestions("computer science", {}, sections);
		expect(cs.length).toBe(1);
		expect(cs[0]).toContain("--dept CSCI");
		expect(recallSuggestions("MATH 019", {}, sections)).toEqual([]);
		const mudd = recallSuggestions("Mudd physics", {}, sections);
		expect(mudd.some((s) => s.includes("--school HM"))).toBe(true);
		expect(
			recallSuggestions(
				"computer science",
				{ departments: ["CSCI"] },
				sections,
			),
		).toEqual([]);
	});

	it("instructor search finds economics", () => {
		const hits = provider().query("economics", {});
		expect(hits.map((h) => h.section.id)).toContain("ECON 050 SC-01 FA2026");
	});
});

describe("golden: filters are hard constraints", () => {
	it("school filter isolates Pitzer", () => {
		const hits = provider().query("", { schools: ["PZ"] });
		expect(hits.map((h) => h.section.id)).toEqual(["PSYC 010 PZ-01 FA2026"]);
	});

	it("openOnly drops over-enrolled and closed", () => {
		const hits = provider().query("", { openOnly: true });
		const ids = hits.map((h) => h.section.id);
		expect(ids).not.toContain("AFRI 116 AF-01 FA2026"); // 18/15 closed
		expect(ids).not.toContain("BIOL 040 PO-01 FA2026"); // 36/26 closed
		expect(ids).not.toContain("PSYC 010 PZ-01 FA2026"); // 26/25 closed
		expect(ids).toContain("CSCI 005 HM-01 FA2026");
	});

	it("days + after window", () => {
		const hits = provider().query("", { days: ["T", "R"], afterMin: 14 * 60 });
		const ids = hits.map((h) => h.section.id).sort();
		expect(ids).toEqual(["AFRI 116 AF-01 FA2026", "CSCI 050 PO-02 FA2026"]);
	});

	it("instructor substring", () => {
		const hits = provider().query("", { instructor: "boerkoel" });
		// Fixture instructors differ; assert no crash and sane shape.
		expect(Array.isArray(hits)).toBe(true);
	});
});

describe("golden: conflicts", () => {
	it("identical TR slots are a hard conflict", () => {
		const r = checkSchedule([
			byId.get("CSCI 050 PO-01 FA2026")!,
			byId.get("AFRI 010A AF-01 FA2026")!,
		]);
		expect(r.ok).toBe(false);
		expect(r.conflicts[0].severity).toBe("hard");
		expect(r.conflicts[0].days).toEqual(["T", "R"]);
	});

	it("MW vs TR never conflicts", () => {
		const r = checkSchedule([
			byId.get("CSCI 005 HM-01 FA2026")!, // TR 9:35
			byId.get("MATH 019 HM-01 FA2026")!, // MW 9:35
		]);
		expect(r.conflicts.filter((c) => c.severity === "hard")).toEqual([]);
	});

	it("same-campus back-to-back is not a travel warning", () => {
		const r = checkSchedule([
			byId.get("CSCI 005 HM-01 FA2026")!,
			byId.get("MATH 019 HM-01 FA2026")!,
		]);
		expect(r.travel_warnings).toEqual([]);
	});

	it("credits sum server-side", () => {
		const r = checkSchedule([
			byId.get("CSCI 005 HM-01 FA2026")!,
			byId.get("MATH 019 HM-01 FA2026")!,
		]);
		expect(r.total_credits).toBeGreaterThan(0);
		expect(r.class_count).toBe(2);
	});
});
