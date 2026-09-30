import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findConflicts, travelWarnings } from "../src/conflicts.js";
import {
	compareTermRecencyDesc,
	normalizeDays,
	normalizeSection,
	normalizeTerm,
	parseCode,
	parseTime,
} from "../src/normalize.js";
import { rawSectionsSchema } from "../src/schema.js";
import { MiniSearchProvider } from "../src/search.js";

const raw = rawSectionsSchema.parse(
	JSON.parse(
		readFileSync(new URL("./fixture-raw.json", import.meta.url), "utf8"),
	),
);
const sections = raw.map(normalizeSection);
const byId = new Map(sections.map((s) => [s.id, s]));

describe("normalize", () => {
	it("freezes canonical IDs", () => {
		const csci = sections.find(
			(s) => s.dept === "CSCI" && s.number === 5 && s.sectionNo === 1,
		)!;
		expect(csci.id).toBe("CSCI 005 HM-01 FA2026");
		expect(csci.code).toBe("CSCI 005");
		expect(csci.term).toBe("FA2026");
	});

	it("keeps raw status + labels, never infers from seats", () => {
		const reopened = sections.find((s) => s.status === "R")!;
		expect(reopened.statusLabel).toBe("Reopened");
		const over = sections.find((s) => s.seats.filled > s.seats.total)!;
		expect(over.seats.available).toBe(0);
	});

	it("stores dual time reps", () => {
		const s = sections[0];
		expect(s.meetings[0].startMin).toBe(575); // 34500s
		expect(s.meetings[0].startStr).toBe("09:35");
		expect(s.meetings[0].start12).toBe("9:35 AM");
	});

	it("drops TBA sentinel meetings (0/0, no days) and blank locations", () => {
		const base = raw[0];
		const tba = normalizeSection({
			...base,
			schedules: [{ startTime: 0, endTime: 0, days: [], locations: [""] }],
		});
		expect(tba.meetings).toEqual([]);
	});

	it("parses loose codes and keeps raw digits", () => {
		expect(parseCode("CSCI51")).toMatchObject({
			dept: "CSCI",
			number: 51,
			numberRaw: "51",
		});
		expect(parseCode("QQQ 000")).toMatchObject({ dept: "QQQ", number: 0 });
		expect(parseCode("CSCI 051 PO-01 FA2026")).toMatchObject({
			dept: "CSCI",
			number: 51,
			school: "PO",
			sectionNo: 1,
			term: "FA2026",
		});
	});

	it("normalizes terms", () => {
		expect(normalizeTerm("FA26")).toBe("FA2026");
		expect(normalizeTerm("Fall 2026")).toBe("FA2026");
		expect(normalizeTerm("2026FA")).toBe("FA2026");
		// Three-digit years are rejected, not silently accepted.
		expect(normalizeTerm("FA123")).toBeNull();
		expect(normalizeTerm("F123")).toBeNull();
	});

	it("orders terms by calendar recency, not lexicographically", () => {
		expect(
			["SP2025", "FA2026", "SP2026", "SU2026"].sort(compareTermRecencyDesc),
		).toEqual(["FA2026", "SU2026", "SP2026", "SP2025"]);
	});

	it("parses times", () => {
		expect(parseTime("1pm")).toBe(780);
		expect(parseTime("10:00")).toBe(600);
		expect(parseTime("13:00")).toBe(780);
	});

	it("rejects day input with no day letters", () => {
		expect(normalizeDays("MWF")).toEqual(["M", "W", "F"]);
		expect(normalizeDays("123")).toBeNull();
		expect(normalizeDays("")).toBeNull();
		expect(normalizeDays("ANY")).toEqual([]);
	});
});

describe("search", () => {
	it("exact code beats description", () => {
		const p = new MiniSearchProvider();
		p.build(sections);
		const hits = p.query("CSCI 005", {});
		expect(hits[0].match).toContain("exact-code");
	});

	it("browse mode returns all with filters", () => {
		const p = new MiniSearchProvider();
		p.build(sections);
		const hits = p.query("", { openOnly: true });
		expect(hits.every((h) => h.section.seats.available > 0)).toBe(true);
	});
});

describe("conflicts", () => {
	it("identical TR slots are exactly one hard conflict", () => {
		const { conflicts } = findConflicts([
			byId.get("CSCI 050 PO-01 FA2026")!,
			byId.get("AFRI 010A AF-01 FA2026")!,
		]);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].severity).toBe("hard");
		expect(conflicts[0].days).toEqual(["T", "R"]);
	});

	it("TR vs MW never conflicts", () => {
		const { conflicts } = findConflicts([
			byId.get("CSCI 005 HM-01 FA2026")!,
			byId.get("MATH 019 HM-01 FA2026")!,
		]);
		expect(conflicts).toEqual([]);
	});

	it("back-to-back on the same day with a gap >= passing is not a conflict", () => {
		const { conflicts } = findConflicts(
			[byId.get("CSCI 005 HM-01 FA2026")!, byId.get("MATH 019 HM-01 FA2026")!],
			10,
		);
		expect(conflicts.filter((c) => c.severity === "tight")).toEqual([]);
	});

	it("travel warnings only fire cross-campus", () => {
		const same = travelWarnings([
			byId.get("CSCI 005 HM-01 FA2026")!,
			byId.get("MATH 019 HM-01 FA2026")!,
		]);
		expect(same).toEqual([]);
	});
});
