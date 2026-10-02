<p align="center">
  <img src="docs/banner.svg" alt="5C Index — course search for the Claremont Colleges" width="720">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kainoa/5c-cli"><img src="https://img.shields.io/npm/v/@kainoa/5c-cli?label=%40kainoa%2F5c-cli" alt="npm: @kainoa/5c-cli"></a>
  <a href="https://www.npmjs.com/package/@kainoa/5c-mcp"><img src="https://img.shields.io/npm/v/@kainoa/5c-mcp?label=%40kainoa%2F5c-mcp" alt="npm: @kainoa/5c-mcp"></a>
  <a href="https://github.com/notkainoa/5C-Index/actions/workflows/publish.yml"><img src="https://github.com/notkainoa/5C-Index/actions/workflows/publish.yml/badge.svg" alt="publish"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <a href="#"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node ≥ 20"></a>
</p>

**5C Index** answers the course questions Claremont Colleges students actually ask — what's offered, what fits, what's open, what conflicts, and what used to be offered — for Pomona, Claremont McKenna, Harvey Mudd, Scripps, and Pitzer. It reads the registrars' shared catalog (via [HyperSchedule](https://hyperschedule.io)) through a local snapshot cache, and speaks three dialects over one engine:

| Interface | What it is | For |
|---|---|---|
| **CLI** — [`@kainoa/5c-cli`](https://www.npmjs.com/package/@kainoa/5c-cli) | the `5c` command: search, get, check, terms, history | terminals, humans |
| **MCP server** — [`@kainoa/5c-mcp`](https://www.npmjs.com/package/@kainoa/5c-mcp) | 5 tools, each with a validated input + output schema | Claude Code, Cursor, Codex, Desktop |
| **Agent skill** — `5c-classes` | routing, golden paths, guardrails | any coding agent |

Agents get tools *and* judgment: never fabricate a course, quote seats with their timestamp, never promise enrollment, report incomplete coverage. Humans get tables on TTY and exactly one JSON document when piped. Seats are snapshots — every answer carries `fetched_at`; verify in CX before enrolling.

**Contents:** [Demo](#demo) · [Install](#install) · [Commands](#commands) · [Contracts](#contracts) · [MCP tools](#mcp-tools) · [Develop](#develop) · [Releasing](#releasing) · [Attribution](#attribution)

## Demo

Real output, term FA2026:

```text
$ 5c search "machine learning" --term FA2026
ID                      TITLE                             MTG             SEATS  ST
CSCI 158 PZ-01 FA2026   Machine Learning                  TR 14:45-16:00   0/51  C
CSCI 051 PO-01 FA2026   Introduction to Computer Science  TR 13:15-14:30  12/24  O
CSCI 181E PO-01 FA2026  Ethical Software Systems          MW 13:15-14:30   8/20  O
MATH 129 HM-01 FA2026   Mathematics of Big Data            MW 13:15-14:30  17/24  O
7 hits (term FA2026, seats as of 2026-10-01T03:28Z).

$ 5c check "CSCI 158 PZ-01 FA2026" "PSYC 092 PZ-01 FA2026"
CONFLICT — 2 classes, 2 credits (raw sum; units differ across colleges)
Conflicts:
  [hard] CSCI 158 PZ-01 FA2026 vs PSYC 092 PZ-01 FA2026 (TR 14:45-16:00)
Seats:
  CSCI 158 PZ-01 FA2026: Closed by registrar (status C; cap 51, filled 58)
```

The overlap check and the seat status are computed by the tool — the agent (or you) never does time math or guesses what "closed" means.

## Install

Requires Node 20 or newer. Three ways in, depending on who is asking:

| You are | Your path |
|---|---|
| A Claude Code / Cursor / Codex / Desktop user | [1. MCP server](#1-mcp-server) |
| Setting up a coding agent to answer course questions | [2. Agent skill and CLI](#2-agent-skill-and-cli) |
| A human in a terminal | [3. CLI on its own](#3-cli-on-its-own) |

### 1. MCP server

Point your host at npm — no clone, no build, no absolute path:

```json
{
  "mcpServers": {
    "5c-index": { "command": "npx", "args": ["-y", "@kainoa/5c-mcp"] }
  }
}
```

Stdio by default. Experimental localhost-only HTTP: `npx -y @kainoa/5c-mcp --http --port 3000`. The five [MCP tools](#mcp-tools) are read-only and schema-validated.

### 2. Agent skill and CLI

```bash
# user-level: available in every project (what most people want)
npx skills add notkainoa/5C-Index --skill 5c-classes -a claude-code -a codex -a cursor -g

# project-level: installs into the current project only (drop the -g)
npx skills add notkainoa/5C-Index --skill 5c-classes -a claude-code -a codex -a cursor
```

This installs the skill that tells an agent which tool to use when, and the guardrails (never fabricate a course; quote seats with `fetched_at`; report `stale` and incomplete coverage; never promise enrollment). The CLI comes along automatically: the skill uses MCP tools if present, else `5c` if on PATH, else runs every call as `npx -y @kainoa/5c-cli@latest`. For long sessions it may suggest a global install — `npm i -g @kainoa/5c-cli` — with your consent first.

### 3. CLI on its own

```bash
npx @kainoa/5c-cli@latest search "machine learning" --term FA2026   # zero install
npm i -g @kainoa/5c-cli                                             # persistent: `5c` on PATH
```

Works standalone for humans. Agents will not know how to drive it well without the skill — install [that too](#2-agent-skill-and-cli) if an agent is the user.

Environment (any install): `FIVE_C_API_BASE` overrides the upstream base URL; `FIVE_C_DATA_DIR` overrides the cache directory (default `~/.5c-index/cache`).

## Commands

```bash
5c search "machine learning" --term FA2026 --json
5c search "psychology" --school pitzer --days TR --after 10:00 --open
5c get "CSCI 158 PZ-01 FA2026" --json
5c check "CSCI 158 PZ-01 FA2026" "PSYC 092 PZ-01 FA2026" --json
5c terms --json
5c history "CSCI 151" --json
5c refresh --term FA2026 --json   # force a fresh seats snapshot
5c schema --json                  # machine catalog of commands and flags
```

Commands: `search` · `get` · `check` · `terms` · `history` · `schema` · `version` · `refresh`. `version` never fetches, so it works offline.

- **Exit codes:** 0 success (including 0 hits, and `check ok:false` — the audit ran, the schedule is invalid) · 1 runtime/fetch · 2 usage · 3 not-found (unknown, incomplete, or ambiguous IDs).
- **IDs:** canonical form is `CSCI 051 PO-01 FA2026` (`{DEPT} {NUM:03d}{suffix} {SCHOOL}-{SEC:02d} {TERM}`). Loose input (`csci51 po`, `Mudd`, `TR`, `1pm`, `Fall 26`) is accepted everywhere and resolves only when unique — several matches come back as candidates, never a silent first pick.

## Contracts

- **Terms:** an unpublished term is an error listing the available terms. `--fallback-term` (CLI) or `allow_term_fallback` (MCP) opts into serving the newest term instead, and the response names requested vs served.
- **IDs:** every input resolves independently. Unknown IDs are reported; loose IDs matching several sections return candidates; batches over the cap (20) are rejected, not truncated.
- **Availability:** registrar `status` O/R means registrable. `seats_open` is reported and never treated as eligibility.
- **Checks:** `ok` says whether conflicts/seats are clean; `complete` says whether every section could be audited. TBA sections are listed in `skipped_tba`, so `ok: true` never implies a verified schedule.
- **History:** the verdict states the window it observed and defers to the user when campuses have separate histories.
- **Provenance:** `fetched_at` is when this process obtained the snapshot; `stale` is computed from the seat TTL. `quarantined` and `duplicate_ids` travel with every result and mean coverage is incomplete.

Full filter grammar, college codes, sorting, and recipes: [skills/5c-classes/SKILL.md](skills/5c-classes/SKILL.md) and its references.

## MCP tools

`search_classes` · `get_classes` · `check_schedule` · `list_terms` · `get_course_history` — all read-only (`readOnlyHint: true`), all network-aware (`openWorldHint: true`), each declaring both an input and an output schema, so the documented shape is the validated shape. Input schemas are strict (`additionalProperties: false`): unknown parameters are rejected with -32602 naming the key — `open_only` → `availability: "has_seat"`, `instructors` → `instructor`.

School codes are registrar-canonical: `CM` (Claremont McKenna; `CMC` accepted as an alias), plus `CG` for Claremont Graduate.

## Develop

```bash
git clone https://github.com/notkainoa/5C-Index && cd 5C-Index
pnpm install && pnpm build
npm link ./packages/cli               # `5c` on PATH from this checkout

pnpm gate        # build + typecheck + lint + tests + offline e2e, in one command
pnpm test        # 90 core + 27 CLI + 19 MCP tests (offline, fixture upstream)
pnpm e2e         # offline end-to-end: CLI matrix + MCP stdio/HTTP + skill/evals lint
pnpm e2e:live    # adds the network suite (live refresh + relevance-50 top-1 set)
pnpm smoke       # pack both adapters, install into a temp prefix, run them there
```

The offline suites run against `tests/fixture-server.mjs`, a fixture HyperSchedule upstream — a red gate means the code changed, not that enrollment shifted. Cache: `~/.5c-index/cache/<TERM>.json`; seats TTL 60s, schedules 30min, catalog 24h. See [plan.md](plan.md) for the review that set these contracts.

## Releasing

Bump `version` in `packages/cli/package.json` and/or `packages/mcp/package.json`, merge to `main`, and the [publish workflow](.github/workflows/publish.yml) publishes exactly the bumped packages via npm trusted publishing (OIDC — no npm token is stored anywhere). Versions already on npm are skipped, so merges without a bump never touch the registry. `5c-core` is private and bundled into both; it is never published.

## Attribution

Course data via [HyperSchedule](https://hyperschedule.io) ([repo](https://github.com/hyperschedule/hyperschedule)) from the 5C registrars. This project caches aggressively, attributes the source, and never presents seats as registration truth.
