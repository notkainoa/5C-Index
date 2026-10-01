# @kainoa/5c-mcp

MCP server for the Claremont Colleges (5C) course catalog — 5 read-only tools
over the shared 5c-core engine: `search_classes` · `get_classes` ·
`check_schedule` · `list_terms` · `get_course_history`.

Every tool declares an input **and** an output schema, so the documented shape
is the validated shape. Input schemas are strict (`additionalProperties:
false`): unknown parameters are rejected with -32602 naming the key.
Logs go to stderr only; stdout carries MCP messages.

## Install

Point your MCP host (Claude Code, Codex, Cursor, Desktop) at npm — no clone, no
build:

```json
{
  "mcpServers": {
    "5c-index": { "command": "npx", "args": ["-y", "@kainoa/5c-mcp"] }
  }
}
```

Requires Node 20 or newer. Experimental stateless Streamable HTTP on localhost:
`npx -y @kainoa/5c-mcp --http --port 3000`.

Data comes from [HyperSchedule](https://hyperschedule.io) (the 5C registrars'
catalogs) through a local snapshot cache; seats are snapshots, always quoted
with `fetched_at` and a `stale` flag.

The CLI twin ([`@kainoa/5c-cli`](https://www.npmjs.com/package/@kainoa/5c-cli)) and docs:
[notkainoa/5C-Index](https://github.com/notkainoa/5C-Index).
