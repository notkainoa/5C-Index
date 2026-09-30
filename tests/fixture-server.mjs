import { readFileSync } from "node:fs";
/**
 * Fixture upstream for offline tests and e2e runs.
 *
 * Speaks the HyperSchedule v4 surface core expects (term/all, term/current,
 * sections/:term, offering-history/:term, course-areas) over real HTTP, so
 * adapters exercise their real fetch path — no monkey-patched global fetch,
 * no network. Point a process at it with FIVE_C_API_BASE.
 *
 * Base data is core's fixture (packages/core/test/fixture-raw.json): 10
 * FA2026 sections covering open/closed/reopened statuses, a half-semester
 * section, and a section with two meeting blocks. On top of it this server
 * adds the cases adapters need to be tested against:
 *   - HIST 100 PO-01: no meeting times (TBA)
 *   - PHYS 070 HM-01: potentialError
 *   - a malformed row that ingest must quarantine
 * and a 2-section SP2026 term.
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_FIXTURE = join(
	HERE,
	"..",
	"packages",
	"core",
	"test",
	"fixture-raw.json",
);

export const FA2026 = "FA2026";
export const SP2026 = "SP2026";
export const UNPUBLISHED_TERM = "SP2099";
export const CURRENT_TERM = FA2026;
export const TERM_LIST = [
	{ year: 2026, term: "FA" },
	{ year: 2026, term: "SP" },
	{ year: 2025, term: "FA" },
];

const START = { year: 2026, month: 8, day: 31 };
const END = { year: 2026, month: 10, day: 16 };

function section({
	dept,
	number,
	suffix = "",
	aff,
	sec = 1,
	term = "FA",
	year = 2026,
	title,
	description = "",
	status = "O",
	filled = 10,
	total = 20,
	credits = 1,
	blocks = [],
	areas = [],
	instructors = [],
	potentialError = false,
}) {
	return {
		courseAreas: areas,
		credits,
		permCount: 0,
		seatsTotal: total,
		seatsFilled: filled,
		status,
		startDate: START,
		endDate: END,
		instructors: instructors.map((name) => ({ name })),
		course: {
			code: {
				department: dept,
				courseNumber: number,
				suffix,
				affiliation: aff,
			},
			title,
			description,
			primaryAssociation: aff,
			potentialError,
		},
		schedules: blocks.map(([days, startTime, endTime, location]) => ({
			startTime,
			endTime,
			// Upstream sends day letters as separate array entries.
			days: String(days).split(""),
			locations: location ? [location] : [],
		})),
		potentialError,
		identifier: {
			department: dept,
			courseNumber: number,
			suffix,
			affiliation: aff,
			sectionNumber: sec,
			year,
			term,
			half: null,
		},
	};
}

function baseSections() {
	return JSON.parse(readFileSync(CORE_FIXTURE, "utf8"));
}

/** FA2026: core fixture + the adapter cases (TBA, flagged, quarantinable). */
export function fa2026Sections() {
	return [
		...baseSections(),
		section({
			dept: "HIST",
			number: 100,
			aff: "PO",
			title: "The Historian's Craft",
			description: "Methods seminar. Meeting times to be arranged.",
			status: "O",
			filled: 12,
			total: 20,
			credits: 1,
			blocks: [],
			instructors: ["Ada Lopez"],
		}),
		section({
			dept: "PHYS",
			number: 70,
			aff: "HM",
			title: "Quantum Mechanics",
			description: "Wave mechanics and operators.",
			status: "O",
			filled: 5,
			total: 30,
			credits: 1,
			blocks: [["MW", 36000, 40500, "Shanahan 1420"]],
			instructors: ["Rue Chen"],
			potentialError: true,
		}),
		// Ingest must quarantine this row, never count it: no identifier.
		{ course: { code: { department: "BRO" } }, schedules: [] },
	];
}

/** SP2026: small, enough for one cross-term assertion. */
export function sp2026Sections() {
	return [
		section({
			dept: "ECON",
			number: 50,
			aff: "SC",
			term: "SP",
			title: "Principles of Economics",
			description: "Introductory micro and macro.",
			status: "O",
			filled: 19,
			total: 20,
			blocks: [["TR", 34500, 39000, "Bauer 30"]],
			instructors: ["Sam Ortiz"],
		}),
	];
}

/** Raw offering-history rows, keyed by affiliation (as upstream sends them). */
export function fa2026History() {
	return [
		{
			code: {
				department: "CSCI",
				courseNumber: 50,
				suffix: "",
				affiliation: "PO",
			},
			terms: [
				{ year: 2026, term: "FA" },
				{ year: 2026, term: "SP" },
			],
		},
		{
			code: {
				department: "CSCI",
				courseNumber: 50,
				suffix: "",
				affiliation: "HM",
			},
			terms: [{ year: 2026, term: "FA" }],
		},
		{
			code: {
				department: "ECON",
				courseNumber: 50,
				suffix: "",
				affiliation: "SC",
			},
			terms: [
				{ year: 2026, term: "FA" },
				{ year: 2025, term: "FA" },
			],
		},
	];
}

const etagFor = (term) => `"fixture-${term}"`;

/**
 * Start the fixture upstream on an ephemeral localhost port.
 * Returns { url, port, requests, close }.
 */
export function startFixtureServer() {
	const requests = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		requests.push({ method: req.method, path });

		const send = (status, body, etag) => {
			const headers = { "Content-Type": "application/json" };
			if (etag) headers.ETag = etag;
			if (status === 304) {
				res.writeHead(304, headers);
				res.end();
				return;
			}
			res.writeHead(status, headers);
			res.end(JSON.stringify(body));
		};

		const conditional = (term) =>
			req.headers["if-none-match"] === etagFor(term);

		if (path === "/term/all") return send(200, TERM_LIST);
		if (path === "/term/current") return send(200, { year: 2026, term: "FA" });
		if (path === "/course-areas") return send(200, []);

		const sections = path.match(/^\/sections\/([A-Za-z0-9]+)$/);
		if (sections) {
			const term = sections[1].toUpperCase();
			if (term === FA2026) {
				if (conditional(term)) return send(304, null, etagFor(term));
				return send(200, fa2026Sections(), etagFor(term));
			}
			if (term === SP2026) {
				if (conditional(term)) return send(304, null, etagFor(term));
				return send(200, sp2026Sections(), etagFor(term));
			}
			return send(404, { error: `No sections for ${term}` });
		}

		const history = path.match(/^\/offering-history\/([A-Za-z0-9]+)$/);
		if (history) {
			const term = history[1].toUpperCase();
			if (term === FA2026) return send(200, fa2026History());
			if (term === SP2026) return send(200, []);
			return send(404, { error: `No history for ${term}` });
		}

		return send(404, { error: `Unrouted path ${path}` });
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				port: address.port,
				requests,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}
