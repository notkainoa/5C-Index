# 5C-Index Proxy (Cloudflare Worker)

Thin caching proxy in front of `banana.hyperschedule.io/v4`. Exists for one
load-bearing reason: **banana CORS-blocks foreign origins** (only
`hyperschedule.io` + subdomains get `ACAO`), so a browser frontend can never
fetch it directly. All browser traffic goes through here.

## Routes

| Method | Route                  | Source / cache behavior                          | CORS |
|--------|------------------------|--------------------------------------------------|------|
| GET    | `/snapshot/:term.json` | R2 snapshot; SWR for the current term            | `*`  |
| GET    | `/meta/:term.json`     | KV `{etag, hash, fetched_at, count}`             | `*`  |
| GET    | `/terms`               | Upstream `/v4/term/all`, KV-cached 10 min        | `*`  |
| GET    | `/healthz`             | `{ok, version, time}` (no origin call)           | —    |
| OPTIONS| any                    | 204 preflight                                    | `*`  |
| other  | any                    | 404 `{ok:false, error:{code, message}}`          | `*`  |

Term form is HyperSchedule-native: `^(FA|SP|SU)\d{4}$` (e.g. `FA2026`).
Anything else → `404 E_BAD_TERM`. Terms past `CURRENT_TERM` don't exist
upstream → `404 E_TERM_NOT_FOUND` (negative-cached, see below).

## TTL table

| Data class              | Upstream volatility      | Edge `Cache-Control`                              | Origin revalidate | Negative / fallback                    |
|-------------------------|--------------------------|---------------------------------------------------|-------------------|----------------------------------------|
| Current-term snapshot   | seconds–min (add/drop)   | `public, max-age=60, stale-while-revalidate=30`   | 60 s; stale served + background refresh | stale served, `X-5C-Stale: true` |
| Past-term snapshot      | frozen                   | `public, max-age=86400, SWR=86400, immutable`     | once (then immutable) | same as above                       |
| Term catalog (`/terms`) | new terms appear suddenly| `public, max-age=600, SWR=86400`                  | 10 min            | stale served with `X-5C-Stale: true`   |
| Unpublished term (404)  | appears without warning  | `public, max-age=300`                             | 5 min (KV `neg:` marker) | —                               |
| Per-term meta           | —                        | `public, max-age=60, SWR=30`                      | with snapshot     | `404 E_NOT_FOUND` until first snapshot |

Upstream reference (observed live 2026-09-25): sections
`public, s-max-age=15, max-age=30, SWR=60`; term/all `max-age=600, SWR=86400`.

## How freshness travels

- **Transport (browsers/CDNs):** `ETag` passes through untouched (upstream
  → R2 `httpEtag` → client, and back via `If-None-Match` both hops);
  `Last-Modified` = `fetched_at`; `Cache-Control` per the table above;
  `X-5C-Fetched-At` = snapshot timestamp; `X-5C-Stale: true/false`.
- **Payload (agents):** `GET /meta/:term.json` →
  `{"etag","hash" (sha1 of raw body),"fetched_at","count"}`.
  Rebuild search indexes when `hash` changes; quote `fetched_at` next to
  any seat number ("Seats as of … — verify in CX before enrolling").

## Politeness (non-negotiable, per upstream goodwill)

- `User-Agent: 5C-Index/proxy (+contact)`, `If-None-Match` on every
  revalidation (`304` bumps `fetched_at` without a download).
- 3-try backoff honoring `Retry-After`, 15 s abort per attempt, retries on
  429/5xx/network only.
- Single-flight per term per isolate + ≤1 in-flight origin request per
  term; 2-min cron keeps the hot snapshot fresh so users rarely wait.
- Per-IP fixed-window rate limit: 60 req/min → `429 E_RATE_LIMITED` with
  `Retry-After` (CLI-shaped `{ok:false, error:{code,message,hint}}` body).
- Circuit breaker: 3 consecutive 5xx → 5-min stale-only mode (serve R2,
  `X-5C-Stale: true`); no cache → `502 E_UPSTREAM`.

## Local test (no wrangler, no new deps)

```bash
node worker/test/smoke.mjs          # 14 tests, TAP-ish, exit 0 on green
pnpm exec tsc -p worker/tsconfig.json  # typecheck with the repo toolchain
```

`src/` is WinterCG-only (no `node:` imports) and uses erasable TypeScript
only, so node 24 imports `../src/*.ts` directly in the harness. `node:`
imports appear only in `test/`. The upstream stub reuses one saved fixture
(`/tmp/5c-sections-FA2026.json`, 2188 sections — refresh with
`curl https://banana.hyperschedule.io/v4/sections/FA2026`); live banana is
otherwise untouched.

## Deployment checklist

1. `wrangler r2 bucket create 5c-index-snapshots`
2. `wrangler kv namespace create META` → paste the id into
   `worker/wrangler.toml` (replacing `REPLACE_WITH_KV_NAMESPACE_ID`).
3. Set `[vars] CURRENT_TERM` to the live value of
   `https://banana.hyperschedule.io/v4/term/current` on each term rollover
   (prewarm falls back to `/term/current` → max of `/term/all` if unset).
4. `wrangler deploy` from `worker/`; attach the route (placeholder in
   `wrangler.toml`) after DNS exists.
5. Cron verification: `wrangler tail` across a `*/2` boundary (expect a
   current-term conditional fetch, usually a 304), then check
   `/meta/<TERM>.json` `fetched_at` advances; after 06:17 UTC check the
   daily full prewarm touched every term + `course-areas`.
6. Open the HyperSchedule outreach issue (edu purpose, caching posture,
   UA+contact, attribution) before pointing real traffic at it.
