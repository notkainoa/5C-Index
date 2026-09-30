# Spike: SQLite FTS5 as a v2 SearchProvider

**Question:** is SQLite FTS5 viable as a v2 `SearchProvider`, and how does it
compare to the current MiniSearch engine at 2k / 10k / 25k / 55k docs?

**One-line verdict:** FTS5 works out of the box (Node 24 builtin, zero deps),
is **4–5× faster to build and 10–50× faster to query at 55k docs**, reproduces
the `code>title>prof>desc` boost ordering via `bm25()` weights — but has **no
fuzzy matching**, so the typo query that MiniSearch answers (`machien
learning` → Machine Learning #1) returns **0 hits**. A trigram side-index
closes the gap (right answer #1) at **3× disk** and very loose recall. At
today's 2.2k-doc corpus MiniSearch is already fast enough (<1 ms); **do not
migrate now**. Migrate when the numeric triggers below fire.

## 1. Environment feasibility (darwin/arm64, Node v24.19.0)

| Option | Result |
|---|---|
| (a) `node:sqlite` builtin (`DatabaseSync`, `CREATE VIRTUAL TABLE t USING fts5(x)`) | **WORKS. SQLite 3.53.3, FTS5 + trigram tokenizer present.** Zero installs, zero `package.json` impact. |
| (b) `better-sqlite3` in sandbox | **Not attempted** — unnecessary given (a). Registry version at check time: **13.0.3**. Would need prebuilds/node-gyp and would violate the spirit of the zero-dep constraint. |
| (c) `sql.js` (wasm) in sandbox | **Not attempted** — unnecessary given (a). Registry version at check time: **1.14.2**. Wasm would add ~MBs of payload and slower bulk insert for no benefit here. |

If (a) had failed, this spike would have stopped here per the mission.
It didn't: `new DatabaseSync(':memory:')` + `CREATE VIRTUAL TABLE t USING
fts5(x)` + a round-trip `MATCH` query all succeed on first try.

## 2. Method

- **Corpus:** live FA2026 snapshot, **2188 sections**, 2.4 MiB JSON
  (`/tmp/5c-perf-fresh/FA2026.json`, already-normalized `Section[]`).
- **Scaling:** in-memory duplication with suffixed ids (`<id>#n`) at
  **x1 = 2,188 / x5 = 10,940 / x12 = 26,256 / x25 = 54,700** docs.
  (Duplication depresses BM25 idf spread and trips MiniSearch's title-phrase
  pre-pass threshold at large scales — noted where it matters. Absolute
  numbers are approximate; *ratios* are the signal.)
- **MiniSearch:** the real `MiniSearchProvider` from
  `packages/core/dist/index.js` (minisearch **7.2.0**, `boost
  {code:5,title:3,instructors:2.5,areas:1.5,description:1}`, `prefix:true`,
  `fuzzy:0.3`, `codeAwareTokenize`, plus its deterministic pre-passes).
- **FTS5:** `node:sqlite` file db in `os.tmpdir()`,
  `CREATE VIRTUAL TABLE courses USING fts5(id UNINDEXED, code, codeFlat,
  title, instructors, areas, description, tokenize='unicode61
  remove_diacritics 2')`. `codeFlat` (`csci005`, one token) mirrors the app's
  `codeAwareTokenize` so prefix queries work — unicode61 alone splits
  `CSCI 005` into `csci`+`005` and a `CSCI05*` query matches nothing without
  it. Ranking: `bm25(courses, 0.0, 5.0, 5.0, 3.0, 2.5, 1.5, 1.0)` reproduces
  the code>title>prof>desc boost vector.
- **Query set (identical intent, both engines):** exact code `CSCI 005`,
  prefix `CSCI05`, phrase `"organic chemistry"`, typo `machien learning`,
  instructor (most frequent real last name in corpus), topical `genetics`,
  plus an FTS5 `boosted` variant (bm25-weighted `organic chemistry`).
- **Timing:** `performance.now()`, 20 iters (10 at x12/x25), median + p95.
  Rerun: `node spikes/fts5/bench.mjs --scales 1,5,12,25 --iters 20 --json out.json`.

## 3. Results

### 3a. Build time (ms, single build, median of one)

| Scale (docs) | MiniSearch build | FTS5 bulk insert | Ratio |
|---|---|---|---|
| x1 (2,188) | 69 | 14 | 4.9× |
| x5 (10,940) | 333 | 76 | 4.4× |
| x12 (26,256) | 859 | 195 | 4.4× |
| x25 (54,700) | 1,930 | 445 | 4.3× |

Both scale ~linearly (~0.035 ms/doc MiniSearch, ~0.008 ms/doc FTS5).
Note `searchClasses` rebuilds the index per cold call (`packages/core/src/index.ts`
says "~60 ms for a full term" — true at x1, **~2 s at 55k**).

### 3b. Index size

| Artifact | Bytes |
|---|---|
| Raw corpus JSON (x1) | 2,350 KiB |
| MiniSearch `toJSON()` (x1) | **1,664 KiB** (0.76 KiB/doc) |
| FTS5 db x1 / x5 / x12 / x25 | **2,120 / 10,844 / 25,276 / 51,744 KiB** (~0.97 KiB/doc) |
| Trigram side-index (x1, fuzzy workaround) | **6,412 KiB** (~3× the main FTS5 db) |

### 3c. Query latency, median ms (p95 in §3d discussion)

| Query | mini x1 | mini x5 | mini x12 | mini x25 | fts x1 | fts x5 | fts x12 | fts x25 |
|---|---|---|---|---|---|---|---|---|
| exact code `CSCI 005` | 0.02 | 0.09 | 0.25 | 0.45 | 0.02 | 0.04 | 0.05 | 0.07 |
| prefix `CSCI05` | 0.02 | 0.09 | 0.33 | 0.46 | 0.02 | 0.03 | 0.06 | 0.10 |
| phrase `"organic chemistry"` | 0.09 | 1.15 | 2.00 | 3.55 | 0.03 | 0.08 | 0.17 | 0.34 |
| typo `machien learning` | 0.38 | 0.62 | 1.27 | 2.30 | 0.01¹ | 0.01¹ | 0.02¹ | 0.02¹ |
| instructor (last name) | 0.46 | 1.88 | 5.49 | 14.72 | 0.02 | 0.05 | 0.09 | 0.18 |
| topical `genetics` | 0.06 | 0.27 | 1.03 | 2.21 | 0.02 | 0.05 | 0.11 | 0.19 |
| boosted (bm25 weights) | — | — | — | — | 0.03 | 0.08 | 0.15 | 0.29 |

¹ FTS5 typo query returns **0 hits** — fast at failing. See §5.

Worst p95s at x25: MiniSearch instructor **20.0 ms**, phrase **4.6 ms**,
`genetics` **3.2 ms**; every FTS5 query p95 ≤ **0.37 ms**.
MiniSearch degrades superlinearly on short-token prefix+fuzzy queries
(instructor last name: 0.46 → 14.7 ms median, 32× for 25× docs);
FTS5 degrades ~linearly and stays sub-ms throughout.

### 3d. Relevance: 6 queries × top-3 (x1)

MiniSearch = live `MiniSearchProvider.query(q, {})` (shows its `why` tags).
FTS5 = column-scoped `MATCH` + `bm25` ordering (see `bench.mjs: ftsQueries`).

| # | Query | MiniSearch top-3 | FTS5 top-3 | Read |
|---|---|---|---|---|
| 1 | `CSCI 005` | CSCI 005 Intro to CS `[exact-code]` ×2 sections | CSCI 005 HM Intro to CS ×2 | **Tie.** Both exact. (FTS5 needs the app's `parseCode` pre-pass to do what MiniSearch's pre-pass does — that code is engine-agnostic, see §6.) |
| 2 | `CSCI05` | CSCI 005 Intro to CS `[exact-code]` ×2 | CSCI 051L Lab / CSCI 051L / CSCI 054 Math Fdns | **Divergent interpretation, both defensible.** MiniSearch's `parseCode` pre-pass reads `CSCI05` as number 5 → CSCI 005. FTS5 `{codeFlat}: csci05*` prefix-matches the 05x family. FTS5 *can* match MiniSearch here by reusing the same pre-pass. |
| 3 | `"organic chemistry"` | CHEM 056 Organic Chem I / CHEM 128 Inorganic / CHEM 101 Organic w/Lab | CHEM 101L Lab ×3 sections | **MiniSearch better.** Its `title-words` bonus + seat/open-status boosts promote the canonical lecture; raw BM25 top-3 is three sections of the same lab. FTS5 needs app-level re-ranking (`finalize`/`seatBoost` are portable). Note MiniSearch's #2 (Inorganic) is a whole-word miss a user would forgive. |
| 4 | `machien learning` | **CSCI 158 Machine Learning** / MATH 129 Big Data / CSCI 051 | **(0 hits)** | **MiniSearch wins outright.** FTS5 has no fuzzy. Trigram workaround (§5) recovers Machine Learning at #1 — at a price. |
| 5 | instructor `Jay` | CHEM/PHYS/NEUR 188L thesis ×3 `[instructor:jay]` (423 hits: prefix+fuzzy recall) | EA thesis ×3 (19 hits: exact-token recall) | **Different recall philosophy.** MiniSearch prefix+fuzzy on a 3-letter name matches 423 docs (high recall, noisy); FTS5 exact-token matches 19 (precise, may miss `Jay` inside longer tokens — it doesn't here, but `Jon` vs `Jonathan` would). |
| 6 | `genetics` | BIOL 113 Molecular Genetics / BIOL 143 Genetics / BIOL 040 Intro Genetics (title-phrase pre-pass, 7 hits) | BIOL 040 ×3 sections (all-fields BM25, 21 hits) | **MiniSearch better at x1** (title-concentrated), but note the artifact: at x12+ the title-phrase pre-pass exceeds its 60-hit cap and MiniSearch falls through to full-text (420 hits) — duplication artifact, yet it shows ranking *regime changes* with corpus size in the current engine. |

**Ranking-quality summary:** ~half of MiniSearch's quality lives *outside*
MiniSearch — `parseCode` exact/prefix/dept pre-passes, title-phrase pre-pass,
`title-words` bonus, seat/status adjustments in `finalize()`. All of that is
plain TypeScript over `Section[]` and ports to an FTS5 provider unchanged.
What does *not* port: fuzzy typo tolerance (query 4) and prefix-inflated
recall (query 5). What FTS5 adds: column-scoped queries (`{instructors}:…`),
phrase search that actually constrains, and deterministic BM25.

## 4. Serialized-index alternative (v1.5?)

| Step (x1, 2,188 docs) | Time | Size |
|---|---|---|
| `provider.toJSON()` stringify | 61 ms | 1,664 KiB (vs 2,350 KiB raw JSON) |
| `JSON.parse` | 5 ms | — |
| `MiniSearch.loadJSON` hydrate | **28 ms** | — |
| Fresh `build()` for comparison | 69 ms | — |

Hydration is ~2.5× faster than rebuild at x1, and the gap widens with corpus
size (build is O(docs), parse/hydrate is O(bytes)). **But:** `MiniSearchProvider.load()`
currently **throws** (`"Serialized index load is v2 work; rebuild via
build()"`), and the serialized payload stores only the MiniSearch index + id
list — sections must still be loaded for `byId`/ranking, so a cold start pays
corpus parse + hydrate anyway. Verdict: **a reasonable v1.5, not a substitute
for this decision.** It attacks the ~2 s rebuild at 55k without changing query
behavior at all (same p95 curve as §3c). Implement `load()` + persist
`{index, sections}` (or index + raw JSON sidecar) if cold-start build time
fires first; it does nothing for the query-latency trigger.

## 5. The fuzzy gap (FTS5's one hard loss)

- `machien learning` on FTS5: **0 hits in 0.01 ms.** FTS5 has no edit-distance
  matching; `fuzzy: 0.3` in MiniSearch is load-bearing (the repo's own eval
  script tests exactly this query, `packages/core/scripts/eval.ts`).
- Workaround probed: parallel `tokenize='trigram'` table over
  `code+title+instructors+description`, queried as OR-of-character-trigrams.
  Result: **CSCI 158 Machine Learning ranks #1**, MATH 129 Big Data #2 —
  correct answer recovered, query still ~1 ms.
- Workaround cost: trigram db **6,412 KiB vs 2,120 KiB main db (3.0×)**,
  build 53 ms vs 14 ms, and recall is extremely loose (**1,860 candidates**
  for the typo query — ranking, not retrieval, saves it). At x25 that side
  index projects to ~150 MiB. Shipping fuzzy-by-trigram means doubling write
  paths and query paths for every field.
- Honest framing: MiniSearch gives typo tolerance *for free on every query*;
  FTS5 charges a second index, 3× disk, and hand-rolled query expansion for
  *worse* precision on short tokens. If typo tolerance is a product
  requirement (it is — it's in eval), FTS5 alone is a regression.

## 6. Verdict table

| Dimension | MiniSearch (now) | FTS5 (`node:sqlite`) | Serialized MiniSearch (v1.5) |
|---|---|---|---|
| Build (x1 / x25) | 69 ms / 1,930 ms | **14 ms / 445 ms** | hydrate 28 ms / ~O(bytes) (est. <500 ms) |
| Query median @55k | 0.45–14.7 ms (worst: short prefix+fuzzy) | **0.02–0.34 ms, all sub-ms** | identical to MiniSearch |
| Query p95 @55k | **up to 20 ms** (instructor name) | ≤0.37 ms | identical to MiniSearch |
| Index size | 1.7 MiB/2.2k docs (in-heap) | 2.1 MiB/2.2k docs (file) | 1.7 MiB/2.2k docs (file) |
| Fuzzy/typo | **yes, free** (`machien`→ML #1) | **no** (0 hits; trigram side-index = 3× disk + loose recall) | yes (same engine) |
| Field boosts | `boost` vector + app pre-passes | `bm25()` weights + same app pre-passes (portable) | same as MiniSearch |
| Ranking quality | best lecture-first (seat/title bonuses) | BM25-only under-ranks lectures without app re-rank | same as MiniSearch |
| Persistence | rebuild every cold start | **file db, WAL, incremental inserts, SQL access** | file JSON, needs `load()` implemented |
| Ops complexity | zero-dep JS, in-process | **zero-dep (Node builtin),** but: schema, migrations, file lifecycle, backup | trivial (one JSON blob) |
| Distribution | bundled JS | Node ≥22.5 required (repo is on 24 — fine); db file or rebuild at install | JSON blob alongside data |

## 7. Recommendation

**Stay on MiniSearch.** At 2,188 docs the worst MiniSearch query is <2 ms
p95 — there is no user-visible problem for FTS5 to solve, and migration
trades away free typo tolerance for speed nobody needs yet.

**Migrate (or re-spike) when ANY of these fire, checked against the
`--scales` sweep in `bench.mjs`:**

1. **Corpus trigger:** sustained corpus ≥ **~25k docs** (≈ x12, e.g. +5
   terms or +history expansion) **AND**
2. **Latency trigger:** p95 of the short-token query class (instructor last
   name, dept prefix) **> 50 ms**, or phrase/topical p95 **> 10 ms**; or
3. **Cold-start trigger:** full-term rebuild **> 1 s** on the P50 user
   machine (already ~1.9 s at 55k on this MacBook) with no appetite for the
   serialized-index v1.5; or
4. **Capability trigger:** you need something MiniSearch can't do —
   incremental updates without full rebuild, SQL-side filtering/joins
   (schedule conflict as a query?), or a shared index across CLI/MCP
   processes.

**What breaks first if nothing changes:** short-token prefix+fuzzy queries
against a growing corpus — instructor-name p95 (14.7 ms median / 20 ms p95 at
55k, 32× growth for 25× docs) crosses 50 ms somewhere near **100–150k docs**,
and cold-start rebuild (~2 s at 55k, linear) becomes the dominant CLI latency
long before that. The v1.5 serialized index defuses the second fuse for ~a
day of work (`load()` + persist); only FTS5 defuses the first.

**If migration happens, the design is:** keep every line of `search.ts`
pre-pass/re-rank code (`parseCode`, title-phrase, `finalize`/`seatBoost`) —
it's engine-agnostic — and put FTS5 behind the existing `SearchProvider`
interface (`build/query/toJSON/load`, which already anticipates a v2).
Budget for the fuzzy story up front: either a trigram side-index (3× disk,
measured here) or an app-level spellfix (e.g. SymSpell over the title/instructor
vocabulary — small, static, no second index) feeding corrected terms into
FTS5. Do not ship FTS5 without one; the eval's `machien learning` case would
regress to zero results.

## 8. Reproduce

```bash
# corpus already at /tmp/5c-perf-fresh/FA2026.json (or refresh live):
FIVE_C_DATA_DIR=/tmp/spike node packages/cli/dist/index.js refresh --term FA2026
# run the spike (no installs; uses node:sqlite + built core dist):
node spikes/fts5/bench.mjs --scales 1,5,12,25 --iters 20 --json spikes/fts5/results.json
```

Files: `bench.mjs` (benchmark, ~350 lines), `results.json` (raw numbers
behind every table above), this README. No existing repo files touched;
no dependencies added.
