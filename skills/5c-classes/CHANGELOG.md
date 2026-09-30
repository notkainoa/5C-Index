# Changelog

## 0.4.0 — 2026-09-27

Truthfulness pass over the whole tool surface; docs regenerated from the code.

- Terms never substitute silently. An unpublished term is `E_TERM_NOT_FOUND`
  (exit 2) listing available terms; `--fallback-term` / `allow_term_fallback`
  opts into serving the newest term and the response names requested vs served.
- Loose IDs resolve only when unique. Multiple matches return candidates
  (`ambiguous` / exit 3 `did_you_mean`) instead of a silent first pick; batches
  over the cap are rejected, not truncated.
- Availability is registrar status (O/R), not seat arithmetic. A closed section
  with spare capacity is excluded by `--open` and still reports its capacity.
- Time windows apply to every meeting: an inverted window is exit 2, and a
  section with blocks outside the window is not a match.
- `check_schedule` reports `complete` + `skipped_tba`; `ok: true` no longer
  implies a complete audit. Seat problems use truthful wording ("Closed by
  registrar" vs "No remaining capacity").
- History states the window it observed, defers a verdict when campuses have
  separate histories, and reports its own freshness plus the enrichment term.
- Every result carries ingest counts (`quarantined`, `duplicate_ids`) and
  `stale`; search adds `snapshot_id` so mid-page refreshes are detectable, and
  hits carry `meetings[]`, `credits`, and `potential_error`.
- `--code` digit rules: `CSCI 051` exact course, `CSCI 05` 050–059 family,
  `CSCI` department.
- Skill docs regenerated: real flag names (`--exclude-conflicts-with`), no
  `level` filter, staleness by the `stale` flag rather than a 24h clock,
  coverage and eligibility caveats, and a recommendation flow.

## 0.3.0 — 2026-09-25

- Search returns `suggestions`: dept/college recall hints ("matches
  department CSCI — retry with --dept CSCI") and code guidance
  ("No PSYC 140 in FA2026 — check the number, or browse --dept PSYC").
- Code-shaped queries with no match return empty instead of fuzzy soup
  ("QQQ 000" → 0 hits, not 461). Partial numbers are unpadded
  ("PSYC 14" → 140s family).
- Terms: unparseable input is `E_BAD_TERM`/exit 2; parseable-but-unpublished
  terms (e.g. SP2027) fall back to the newest term with a warning.
- History gains a plain-language `verdict` ("Usually spring (SP 9 vs FA 7)").
- Evals: tool-paths 18 → 26 prompts; new relevance-50 top-1 set.

## 0.2.0 — 2026-09-25

- MCP strictness: unknown params now rejected with -32602 naming the key
  (was: silently ignored). Use `availability` (not `open_only`),
  `instructor` singular (not `instructors`), `credits_min`/`credits_max`.
- Canonical school code is `CM` (registrar truth); `CMC` accepted as alias.
  Added `CG`. Fixed `PO CMS…` typo and `instructors` (plural) recipe.
- New `search_classes` inputs: `sort`, `explain`, `credits_min`/`credits_max`;
  new `get_course_history` input: `term`. `get_classes` returns `suggestions`
  for unknown IDs.
- Freshness language: field is `fetched_at` (display as "as of …"), not `as_of`.
- Pagination: `offset`/`next_offset`/`has_more` + `total_count` (MCP) vs
  `total` (CLI). No `cursor`/`next_cursor`.
- Buried rules promoted: trust `status` over seat arithmetic; TBA sections
  never match day/time filters and never conflict; half-semester sections
  only conflict on overlapping dates.

## 0.1.0 — 2026-09-25

- Initial `5c-classes` skill: SKILL.md + search-syntax, ids-and-terms, troubleshooting refs.
- Covers 5c MCP tools: search_classes, get_classes, check_schedule, list_terms, get_course_history.
