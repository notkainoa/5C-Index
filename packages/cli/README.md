# @kainoa/5c-cli

`5c` — agent-first CLI for searching the Claremont Colleges (5C) course
catalog: search, section details, schedule conflict audits, terms, and course
history. JSON envelopes for agents, tables for humans.

## Install

```bash
npx @kainoa/5c-cli@latest search "machine learning" --term FA2026 --json
npm i -g @kainoa/5c-cli   # persistent: puts `5c` on PATH
```

Requires Node 20 or newer. Data comes from
[HyperSchedule](https://hyperschedule.io) (the 5C registrars' catalogs) through
a local snapshot cache; seats are snapshots, always quoted with `fetched_at`
and a `stale` flag.

Exit codes: 0 success · 1 runtime/fetch · 2 usage · 3 not-found.
`5c schema --json` prints the machine catalog of commands and flags; every
JSON result is exactly one document on stdout.

Docs, the MCP twin ([`@kainoa/5c-mcp`](https://www.npmjs.com/package/@kainoa/5c-mcp)), and the
agent skill: [notkainoa/5C-Index](https://github.com/notkainoa/5C-Index).
