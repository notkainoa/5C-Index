/**
 * Live smoke eval: 5 representative queries against the real API.
 * Informational (not CI-gating): prints top IDs + timings.
 * Usage: pnpm --filter 5c-core eval
 */
import {
	checkScheduleByIds,
	getCourseHistory,
	listTerms,
	searchClasses,
} from "../src/index.js";

const cases: { name: string; run: () => Promise<string> }[] = [
	{
		name: "exact code",
		run: async () =>
			(await searchClasses("CSCI 005", { term: "FA2026", limit: 3 })).result
				.hits[0]?.id ?? "NONE",
	},
	{
		name: "keyword + filters",
		run: async () =>
			(
				await searchClasses("psychology", {
					term: "FA2026",
					schools: ["PZ"],
					open: true,
					limit: 3,
				})
			).result.hits[0]?.id ?? "NONE",
	},
	{
		name: "fuzzy typo",
		run: async () =>
			(await searchClasses("machien learning", { term: "FA2026", limit: 3 }))
				.result.hits[0]?.id ?? "NONE",
	},
	{
		name: "conflict check",
		run: async () => {
			const { result } = await checkScheduleByIds(
				["CSCI 158 PZ-01 FA2026", "PSYC 092 PZ-01 FA2026"],
				{ term: "FA2026" },
			);
			return `ok=${result.ok} complete=${result.complete} conflicts=${result.conflicts.length} credits=${result.total_credits}`;
		},
	},
	{
		name: "history rotation",
		run: async () =>
			(
				await getCourseHistory("CSCI 151", { term: "FA2026" })
			).rotation_note.slice(0, 80),
	},
	{
		name: "terms",
		run: async () => (await listTerms({})).current,
	},
];

let failed = 0;
for (const c of cases) {
	const t0 = Date.now();
	try {
		const out = await c.run();
		console.log(`PASS ${c.name} (${Date.now() - t0}ms): ${out}`);
		if (out === "NONE") failed++;
	} catch (err) {
		failed++;
		console.log(`FAIL ${c.name}: ${(err as Error).message}`);
	}
}
if (failed > 0) {
	console.log(`${failed} eval(s) failed`);
	process.exit(1);
}
console.log("smoke eval green");
