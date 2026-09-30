import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
// FTS5 vs MiniSearch spike benchmark — 5C-Index v2 SearchProvider evaluation.
// Runnable:  node spikes/fts5/bench.mjs [--scales 1,5,12,25] [--iters N] [--data PATH] [--json]
// Reads the FA2026 corpus (raw sections array, as written by the CLI refresh / /tmp cache),
// duplicates it in-memory for scaling, and measures both engines on the same query set.
// Uses ONLY node builtins + the repo's already-built core dist + node:sqlite (no installs).
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIST = path.resolve(HERE, "../../packages/core/dist/index.js");
const { MiniSearchProvider, normalizeTermSections } = await import(CORE_DIST);
const corePkg = JSON.parse(
	fs.readFileSync(
		path.resolve(HERE, "../../packages/core/package.json"),
		"utf8",
	),
);

// ---------------------------------------------------------------- corpus ---
function resolveData(arg) {
	if (arg && fs.existsSync(arg)) return arg;
	const env = process.env.FIVE_C_DATA_DIR;
	if (env && fs.existsSync(path.join(env, "FA2026.json")))
		return path.join(env, "FA2026.json");
	for (const p of [
		"/tmp/5c-perf-fresh/FA2026.json",
		"/tmp/spike/FA2026.json",
	]) {
		if (fs.existsSync(p)) return p;
	}
	throw new Error(
		"FA2026.json not found. Pass --data PATH or set FIVE_C_DATA_DIR.",
	);
}

function loadSections(dataPath) {
	const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
	const arr = Array.isArray(raw) ? raw : raw.sections;
	// /tmp cache files hold already-normalized Sections (have string `id` +
	// `dept`); raw API payloads need normalizeTermSections. Detect by shape.
	const sections =
		arr.length > 0 && typeof arr[0].id === "string" && arr[0].dept
			? arr.filter((s) => s.term === "FA2026")
			: normalizeTermSections(arr, "FA2026");
	return { sections, bytes: fs.statSync(dataPath).size };
}

function duplicate(sections, k) {
	if (k === 1) return sections;
	const out = new Array(sections.length * k);
	let i = 0;
	for (let n = 0; n < k; n++)
		for (const s of sections) out[i++] = { ...s, id: `${s.id}#${n}` };
	return out;
}

// ---------------------------------------------------------------- helpers --
function stats(samples) {
	const a = [...samples].sort((x, y) => x - y);
	const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
	return {
		n: a.length,
		median: q(0.5),
		p95: q(0.95),
		min: a[0],
		max: a[a.length - 1],
	};
}

function timeIt(fn, iters) {
	// warmup
	for (let i = 0; i < Math.min(3, iters); i++) fn();
	const samples = [];
	for (let i = 0; i < iters; i++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	return stats(samples);
}

function toDoc(s) {
	return {
		id: s.id,
		code: `${s.dept} ${String(s.number).padStart(3, "0")}${s.suffix} ${s.school}`,
		// codeFlat mirrors the app's codeAwareTokenize ("CSCI051" stays one token)
		// so FTS5 prefix queries work: {codeFlat} : csci05*
		codeFlat:
			`${s.dept}${String(s.number).padStart(3, "0")}${s.suffix}`.toLowerCase(),
		title: s.title,
		instructors: s.instructors.join(" "),
		areas: s.areas.join(" "),
		description: s.description,
	};
}

// ---------------------------------------------------------------- MiniSearch
function benchMiniBuild(sections) {
	const t0 = performance.now();
	const p = new MiniSearchProvider();
	p.build(sections);
	return { ms: performance.now() - t0, provider: p };
}

function benchMiniQuery(p, q, iters) {
	let nHits = 0;
	const s = timeIt(() => {
		nHits = p.query(q, {}).length;
	}, iters);
	return { ...s, hits: nHits };
}

function benchMiniSerialized(p) {
	const t0 = performance.now();
	const json = p.toJSON();
	const stringifyMs = performance.now() - t0;
	const bytes = Buffer.byteLength(json, "utf8");
	const t1 = performance.now();
	const parsed = JSON.parse(json);
	const parseMs = performance.now() - t1;
	// Provider.load() is unimplemented (throws: "v2 work"), so hydration is
	// measured on raw MiniSearch.loadJSON over the inner index payload.
	const t2 = performance.now();
	let hydrateMs = Number.NaN;
	let hydrateNote = "";
	try {
		const m = MiniSearch.loadJSON(JSON.stringify(parsed.index), {
			fields: ["code", "title", "instructors", "areas", "description"],
		});
		hydrateMs = performance.now() - t2;
		hydrateNote = `loadJSON ok (${m.documentCount} docs)`;
	} catch (e) {
		hydrateNote = `loadJSON failed: ${e.message}`;
	}
	return { bytes, stringifyMs, parseMs, hydrateMs, hydrateNote };
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// minisearch is an existing workspace dep (packages/core), loaded for the
// serialized-hydration probe only — no installs involved.
const { default: MiniSearch } = await import(
	path.resolve(
		HERE,
		"../../packages/core/node_modules/minisearch/dist/es/index.js",
	)
);

// ---------------------------------------------------------------- FTS5 ------
const FTS_DDL =
	"CREATE VIRTUAL TABLE courses USING fts5(" +
	"id UNINDEXED, code, codeFlat, title, instructors, areas, description, " +
	`tokenize='unicode61 remove_diacritics 2')`;

function benchFtsBuild(sections, tag) {
	const dbPath = path.join(os.tmpdir(), `spike-fts5-${tag}.db`);
	try {
		fs.unlinkSync(dbPath);
	} catch {}
	const db = new DatabaseSync(dbPath);
	const t0 = performance.now();
	db.exec(FTS_DDL);
	const ins = db.prepare(
		"INSERT INTO courses(id, code, codeFlat, title, instructors, areas, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const txn = db.prepare("BEGIN");
	const commit = db.prepare("COMMIT");
	txn.run();
	for (const s of sections) {
		const d = toDoc(s);
		ins.run(
			d.id,
			d.code,
			d.codeFlat,
			d.title,
			d.instructors,
			d.areas,
			d.description,
		);
	}
	commit.run();
	const ms = performance.now() - t0;
	db.close();
	const bytes = fs.statSync(dbPath).size;
	return { ms, bytes, dbPath };
}

function openDb(dbPath) {
	return new DatabaseSync(dbPath, { readOnly: true });
}

// FTS5 query set. Boosted ranking reproduces code>title>prof>desc via
// bm25 weights over (id, code, codeFlat, title, instructors, areas, description).
const BM25 = "bm25(courses, 0.0, 5.0, 5.0, 3.0, 2.5, 1.5, 1.0)";
function ftsQueries(instructorLast) {
	const last = instructorLast.replace(/"/g, "");
	return [
		{
			key: "exact-code",
			match: `{code} : "csci 005"`,
			note: "column-scoped phrase",
		},
		{ key: "prefix", match: "{codeFlat} : csci05*", note: "codeFlat prefix*" },
		{ key: "phrase", match: `"organic chemistry"`, note: "phrase query" },
		{
			key: "typo",
			match: "machien learning",
			note: "no fuzzy in FTS5 -> expect 0",
		},
		{
			key: "instructor",
			match: `{instructors} : "${last}"`,
			note: "column-scoped",
		},
		{ key: "topical", match: "genetics", note: "plain term" },
		{
			key: "boosted",
			match: "organic chemistry",
			note: "bm25(5,5,3,2.5,1.5,1)",
			boosted: true,
		},
	];
}

function benchFtsQuery(db, match, iters, boosted) {
	const countSql = `SELECT COUNT(*) AS n FROM courses WHERE courses MATCH '${match.replace(/'/g, "''")}'`;
	const rank = boosted ? `, ${BM25} AS r` : "";
	const order = boosted ? "ORDER BY r" : "ORDER BY rank";
	const topSql = `SELECT id, code, title ${rank} FROM courses WHERE courses MATCH '${match.replace(/'/g, "''")}' ${order} LIMIT 3`;
	let total = 0;
	let rows = [];
	const s = timeIt(() => {
		rows = db.prepare(topSql).all();
	}, iters);
	try {
		total = db.prepare(countSql).get().n;
	} catch {}
	return { ...s, hits: total, top3: rows.slice(0, 3) };
}

// Trigram workaround for the fuzzy gap: OR the query's character trigrams so
// docs sharing the most trigrams rank first (typo tolerance by partial match).
function trigramOr(token) {
	const t = token.toLowerCase();
	const tris = new Set();
	for (let i = 0; i + 3 <= t.length; i++) tris.add(t.slice(i, i + 3));
	return [...tris].map((g) => `"${g}"`).join(" OR ");
}

function benchTrigram(sections, tag) {
	// Workaround-cost probe for the fuzzy gap: a parallel trigram index.
	const dbPath = path.join(os.tmpdir(), `spike-fts5-tri-${tag}.db`);
	try {
		fs.unlinkSync(dbPath);
	} catch {}
	const db = new DatabaseSync(dbPath);
	const t0 = performance.now();
	db.exec(
		`CREATE VIRTUAL TABLE tri USING fts5(id UNINDEXED, text, tokenize='trigram')`,
	);
	const ins = db.prepare("INSERT INTO tri(id, text) VALUES (?, ?)");
	db.prepare("BEGIN").run();
	for (const s of sections) {
		const d = toDoc(s);
		ins.run(d.id, `${d.code} ${d.title} ${d.instructors} ${d.description}`);
	}
	db.prepare("COMMIT").run();
	const ms = performance.now() - t0;
	db.close();
	return { ms, bytes: fs.statSync(dbPath).size, dbPath };
}

// ---------------------------------------------------------------- main ------
const args = Object.fromEntries(
	process.argv.slice(2).flatMap((a, i, arr) => {
		if (a.startsWith("--")) {
			const k = a.slice(2);
			const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1";
			return [[k, v]];
		}
		return [];
	}),
);
const scales = (args.scales || "1,5,12,25").split(",").map(Number);
const ITERS = Number(args.iters || 20);
const dataPath = resolveData(args.data);

const { sections: base, bytes: corpusBytes } = loadSections(dataPath);
// Most frequent REAL instructor last name -> realistic instructor query
// (skip placeholders like Staff/TBD).
const counts = new Map();
for (const s of base)
	for (const i of s.instructors) {
		const last = i.trim().split(/\s+/).pop();
		if (last && !/^(staff|tbd)$/i.test(last))
			counts.set(last, (counts.get(last) || 0) + 1);
	}
const topInstructor =
	[...counts.entries()].sort((a, b) => b[0] && b[1] - a[1])[0]?.[0] ?? "Smith";

const MINI_QUERIES = [
	"CSCI 005",
	"CSCI05",
	'"organic chemistry"',
	"machien learning",
	topInstructor,
	"genetics",
];
const FTS_Q = ftsQueries(topInstructor);

const env = {
	node: process.version,
	platform: `${os.platform()}/${os.arch()}`,
	sqlite: new DatabaseSync(":memory:").prepare("select sqlite_version()").get(),
	fts5: false,
	minisearch: corePkg.dependencies.minisearch,
};
try {
	const probe = new DatabaseSync(":memory:");
	probe.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
	env.fts5 = true;
	probe.close();
} catch (e) {
	env.fts5Error = e.message;
}

const report = {
	env,
	corpus: {
		dataPath,
		sections: base.length,
		jsonBytes: corpusBytes,
		topInstructor,
	},
	scales: {},
};

for (const k of scales) {
	const docs = duplicate(base, k);
	const iters = k >= 12 ? Math.min(ITERS, 10) : ITERS;
	console.log(`\n=== x${k}  (${docs.length} docs, iters=${iters}) ===`);

	// MiniSearch
	const mb = benchMiniBuild(docs);
	console.log(`MiniSearch build: ${mb.ms.toFixed(0)} ms`);
	const miniQueries = {};
	for (const q of MINI_QUERIES) {
		const r = benchMiniQuery(mb.provider, q, iters);
		miniQueries[q] = r;
		console.log(
			`  mini q=${JSON.stringify(q)} median=${r.median.toFixed(2)}ms p95=${r.p95.toFixed(2)}ms hits=${r.hits}`,
		);
	}
	let ser = null;
	if (k === 1) {
		ser = benchMiniSerialized(mb.provider);
		console.log(
			`  mini serialized: ${(ser.bytes / 1024).toFixed(0)} KiB, stringify=${ser.stringifyMs.toFixed(0)}ms parse=${ser.parseMs.toFixed(0)}ms hydrate=${Number.isNaN(ser.hydrateMs) ? "n/a" : `${ser.hydrateMs.toFixed(0)}ms`} (${ser.hydrateNote})`,
		);
	}

	// FTS5
	const fb = benchFtsBuild(docs, `x${k}`);
	console.log(
		`FTS5 build: ${fb.ms.toFixed(0)} ms, db=${(fb.bytes / 1024).toFixed(0)} KiB`,
	);
	const db = openDb(fb.dbPath);
	const ftsQueriesOut = {};
	for (const { key, match, note, boosted } of FTS_Q) {
		const r = benchFtsQuery(db, match, iters, boosted);
		ftsQueriesOut[key] = {
			medianMs: r.median,
			p95Ms: r.p95,
			hits: r.hits,
			note,
			top3: r.top3,
		};
		console.log(
			`  fts  q=${key} median=${r.median.toFixed(2)}ms p95=${r.p95.toFixed(2)}ms hits=${r.hits} [${note}]`,
		);
	}
	let tri = null;
	if (k === 1) {
		tri = benchTrigram(docs, "x1");
		const tdb = openDb(tri.dbPath);
		// Honest fuzzy workaround: OR-of-trigrams over the typo'd token.
		const triMatch = `(${trigramOr("machien")}) OR (${trigramOr("learning")})`;
		const tsel = `SELECT id FROM tri WHERE tri MATCH '${triMatch}' ORDER BY rank LIMIT 3`;
		let trows = [];
		const tq = timeIt(() => {
			trows = tdb.prepare(tsel).all();
		}, iters);
		let ttotal = 0;
		try {
			ttotal = tdb
				.prepare(`SELECT COUNT(*) AS n FROM tri WHERE tri MATCH '${triMatch}'`)
				.get().n;
		} catch (e) {
			ttotal = -1;
		}
		tdb.close();
		const byId = new Map(docs.map((s) => [s.id, s]));
		const ttop = trows.slice(0, 3).map((r) => {
			const s = byId.get(r.id);
			return s ? `${s.code} | ${s.title}` : r.id;
		});
		tri = {
			...tri,
			typoProbe: {
				match: `${triMatch.slice(0, 80)}…`,
				medianMs: tq.median,
				hits: ttotal,
				top3: ttop,
			},
		};
		console.log(
			`  trigram: build=${tri.ms.toFixed(0)}ms db=${(tri.bytes / 1024).toFixed(0)}KiB typo-probe median=${tq.median.toFixed(2)}ms hits=${ttotal}`,
		);
		for (const t of ttop) console.log(`    tri-top: ${t}`);
	}
	db.close();

	// Relevance snapshot (top-3 both engines, x1 only to keep output small).
	let relevance = null;
	if (k === 1) {
		relevance = {
			minisearch: Object.fromEntries(
				MINI_QUERIES.map((q) => [
					q,
					mb.provider
						.query(q, {})
						.slice(0, 3)
						.map(
							(h) =>
								`${h.section.code} | ${h.section.title} [${h.match.join(",")}]`,
						),
				]),
			),
			fts5: Object.fromEntries(
				Object.entries(ftsQueriesOut).map(([k2, v]) => [
					k2,
					v.top3.map((r) => `${r.code} | ${r.title}`),
				]),
			),
		};
	}

	// Keep one FTS db file for inspection (x1), delete the rest.
	if (k !== 1) {
		try {
			fs.unlinkSync(fb.dbPath);
		} catch {}
	} else {
		report.keptDb = fb.dbPath;
	}

	report.scales[`x${k}`] = {
		docs: docs.length,
		minisearch: {
			buildMs: mb.ms,
			queries: Object.fromEntries(
				Object.entries(miniQueries).map(([q, r]) => [
					q,
					{ medianMs: r.median, p95Ms: r.p95, hits: r.hits },
				]),
			),
			...(ser ? { serialized: ser } : {}),
		},
		fts5: {
			buildMs: fb.ms,
			dbBytes: fb.bytes,
			queries: Object.fromEntries(
				Object.entries(ftsQueriesOut).map(([k2, v]) => [
					k2,
					{ medianMs: v.medianMs, p95Ms: v.p95Ms, hits: v.hits, note: v.note },
				]),
			),
			...(tri
				? {
						trigram: {
							buildMs: tri.ms,
							dbBytes: tri.bytes,
							typoProbe: {
								medianMs: tri.typoProbe.medianMs,
								hits: tri.typoProbe.hits,
							},
						},
					}
				: {}),
		},
		...(relevance ? { relevance } : {}),
	};
}

if (args.json) {
	fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
	console.log(`\nreport -> ${args.json}`);
} else {
	console.log(`\n${JSON.stringify(report.env)}`);
}
