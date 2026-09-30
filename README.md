# 5C Index

Search engine for Claremont Colleges (5C) classes — built for agents, usable by humans.

One engine, three interfaces, one skill:

- **`5c` CLI** (`packages/cli`) — every coding agent with a shell can use it today.
- **MCP server** (`packages/mcp`) — 5 tools for Claude Code / Codex / Cursor / Desktop.
- **`5c-classes` skill** (`skills/5c-classes`) — routing + golden paths + guardrails.
- **`5c-core`** (`packages/core`) — fetch, cache, normalize, search, conflicts, history. The CLI and MCP are adapters over this surface and hold no policy of their own.

Data: [HyperSchedule v4](https://banana.hyperschedule.io/v4/sections/FA2026), the 5C registrars' own catalogs, read through a local snapshot cache. Seats are snapshots — always quoted with `fetched_at` and the `stale` flag; verify in CX before enrolling. Coverage caveats are in `skills/5c-classes/references/ids-and-terms.md`. See [plan.md](plan.md) for the review that set these contracts.

Requires Node 20 or newer.

## Install

Everything is on npm. The CLI and MCP server each bundle core, so each is one
package — and can be zero-install:

```bash
# CLI, zero install:
npx 5c-cli@latest search "machine learning" --term FA2026 --json

# CLI, persistent (puts `5c` on PATH):
npm i -g 5c-cli

# MCP — no clone, no build; add to Claude Code / Codex / Cursor / Desktop:
{
  "mcpServers": {
    "5c-index": { "command": "npx", "args": ["-y", "5c-mcp"] }
  }
}

# skill:
npx skills add notkainoa/5C-Index --skill 5c-classes -a claude-code -a codex -a cursor
```

Requires Node 20 or newer. For caller-supplied data, `FIVE_C_API_BASE` overrides
the upstream base URL and `FIVE_C_DATA_DIR` overrides the cache directory.

## Quick start

```bash
5c search "machine learning" --term FA2026 --json
5c search "psychology" --school pitzer --days TR --after 10:00 --open
5c get "CSCI 158 PZ-01 FA2026" --json
5c check "CSCI 158 PZ-01 FA2026" "PSYC 092 PZ-01 FA2026" --json
5c terms --json
5c history "CSCI 151" --json
5c refresh --term FA2026 --json   # force fresh seats snapshot
5c schema --json                  # machine catalog of commands and flags
```

Commands: `search` · `get` · `check` · `terms` · `history` · `schema` · `version` · `refresh`.
Exit codes: 0 success (including 0 hits, and `check ok:false` — the audit ran and the schedule is invalid) · 1 runtime/fetch · 2 usage (bad flags, unparseable terms, unpublished terms, over-cap batches) · 3 not-found (unknown, incomplete, or ambiguous IDs).
Stdout is exactly one JSON document when piped (or `--json`); humans get tables on TTY. `version` never fetches, so it works offline.

IDs are canonical: `CSCI 051 PO-01 FA2026` (`{DEPT} {NUM:03d}{suffix} {SCHOOL}-{SEC:02d} {TERM}`).
Loose input is accepted everywhere (`csci51 po`, `Mudd`, `TR`, `1pm`, `Fall 26`) and
resolves only when it is unique — several matches come back as candidates.

## Contracts

- **Terms:** an unpublished term is an error listing the available terms. `--fallback-term` (CLI) or `allow_term_fallback` (MCP) opts into serving the newest term instead, and the response names requested vs served.
- **IDs:** every input resolves independently. Unknown IDs are reported; loose IDs that match several sections return candidates; batches over the cap (20) are rejected instead of truncated.
- **Availability:** registrar `status` O/R means registrable. `seats_open` is reported and never treated as eligibility.
- **Checks:** `ok` says whether conflicts/seats are clean; `complete` says whether every section could be audited. TBA sections are listed in `skipped_tba`, so `ok: true` never implies a verified schedule.
- **History:** the verdict states the window it observed and defers to the user when campuses have separate histories.
- **Provenance:** `fetched_at` is when this process obtained the snapshot; `stale` is computed from the seat TTL. `quarantined` and `duplicate_ids` travel with every result and mean coverage is incomplete.

## MCP

Stdio (default):

```bash
npx -y 5c-mcp
```

Experimental stateless Streamable HTTP on localhost (`POST /mcp`). It binds
`127.0.0.1` by default and caps request bodies; hosting is not a supported
distribution yet:

```bash
npx -y 5c-mcp --http --port 3000
```

Tools: `search_classes` · `get_classes` · `check_schedule` · `list_terms` · `get_course_history`.

All five are read-only (`readOnlyHint: true`), touch the network (`openWorldHint: true`), and declare both an input and an output schema, so the documented shape is the validated shape. Input schemas are strict (`additionalProperties: false`): unknown parameters are rejected with -32602 naming the key — `open_only` → use `availability: "has_seat"`, `instructors` → `instructor`.

School codes are registrar-canonical: `CM` (Claremont McKenna; `CMC` accepted as an alias), plus `CG`.

## Develop

```bash
git clone https://github.com/notkainoa/5C-Index
cd 5C-Index
pnpm install
pnpm build
npm link ./packages/cli              # `5c` on PATH from this checkout
node ./packages/mcp/dist/server.js  # MCP from this checkout (needs pnpm build)
```

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test        # 90 core + 27 CLI + 19 MCP tests (offline, mocked/fixture upstream)
pnpm e2e         # offline end-to-end: CLI matrix + MCP stdio/HTTP + skill/evals lint
pnpm e2e:live    # adds the network suite (live refresh + relevance-50 top-1 set)
pnpm gate        # build + typecheck + lint + tests + offline e2e, in one command
pnpm smoke       # pack the CLI, install it into a temp prefix, run `5c version` offline
```

The offline suites run against `tests/fixture-server.mjs`, a fixture HyperSchedule
upstream, so a red gate means the code changed, not that enrollment shifted. Live
expectations live in `tests/evals/relevance-50.json` and only run under `--live`.

Cache: `~/.5c-index/cache/<TERM>.json` (override with `FIVE_C_DATA_DIR`).
Seats TTL 60s, schedules 30min, catalog 24h. Every response carries `fetched_at` + `stale`.
In-process search index is cached per term+hash (repeat search ~3ms vs ~80ms cold-build).

## Releasing

Bump `version` in `packages/cli/package.json` and/or `packages/mcp/package.json`,
merge to `main`, and `.github/workflows/publish.yml` publishes exactly the
bumped packages via npm trusted publishing (OIDC — no npm token is stored
anywhere). Versions already on npm are skipped, so merges without a bump never
touch the registry. `5c-core` is private and bundled into both; it is never
published.

## Attribution

Course data via [HyperSchedule](https://hyperschedule.io) ([repo](https://github.com/hyperschedule/hyperschedule)) from the 5C registrars. This project caches aggressively, attributes the source, and never presents seats as registration truth.
