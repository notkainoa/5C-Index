# Search syntax (5c `search_classes` / `5c search`)

Minimal query: `search_classes({query: "machine learning"})`.
Full example: `search_classes({query: "ml", schools: ["PO","HM"], days: ["T","R"], starts_after: "10:00", availability: "has_seat", limit: 10})`.

CLI twin: `5c search "ml" --school PO --school HM --days TR --after 10am --open --limit 10`.

Browsing with no query and no filters is allowed: it lists the term's catalog from the top of the ranking.

## Filter reference

| Filter (MCP) | CLI flag | Values |
|---|---|---|
| `query` | `[QUERY]` | Free text: title, description, code, instructor. Empty = browse. |
| `term` | `--term` | `FA2026` (default: current). Unpublished term is an error; see ids-and-terms.md. |
| `schools` | `--school` | `PO CM HM SC PZ` + joint codes; `CMC` accepted as alias for `CM`; names/aliases accepted (`pitzer`, `Mudd`, `hm`). |
| `departments` | `--dept` | `CSCI MATH ECON …` (case-insensitive). Unknown codes are rejected, not ignored. |
| `code` | `--code` | Prefix. Digit count matters: `CSCI 051` = that course, `CSCI 05` = the whole 050–059 family, `CSCI` = the department. |
| `days` | `--days` | Must meet on ALL listed days, within the time window. `TR T/R TuTh MWF`. **R = Thursday.** |
| `starts_after` / `ends_before` | `--after` / `--before` | `HH:MM` 24h (`13:00`); CLI also takes `1pm`, `10am`. |
| `instructor` | `--instructor` | Substring, case-insensitive. |
| `course_areas` | `--area` | Course-area codes as the registrar writes them, uppercased. Codes are per-college: an area that satisfies a requirement at one campus does not automatically apply at another. |
| `credits_min` / `credits_max` | `--credits` | MCP: numbers forming a range; CLI: `1` or `0.5-1`. |
| `availability: has_seat` | `--open` | Registrar status O or R. Capacity is reported separately and is not eligibility. |
| `exclude_conflicts_with` | `--exclude-conflicts-with` | Canonical section IDs in the searched term; overlapping hits are dropped server-side. An anchor that does not resolve is an error (exit 3), never a silent no-op. |
| `limit` (1–50, default 10) | `--limit/--offset` | Page with `offset`/`next_offset`/`has_more`; don't widen the query. |
| `sort` | `--sort` | `relevance\|time\|seats\|code` (default relevance). |

## Time windows

`--after`/`--before` (and `days`) apply to the WHOLE schedule: every meeting must fit the window and include every listed day. A section with a 09:00 block and a 14:00 block does not satisfy "afternoons only", and it never satisfies an inverted window (`--after 13:00 --before 11:00` is an error, exit 2).

## Text operators

- Quoted or long queries bias to exact title-phrase matches.
- Department-only (`csci`) returns the whole department; combine with filters.
- Typo tolerance is on (`machien` → `machine`), but exact codes always outrank fuzzy text.
- What is NOT supported: OR across fields, wildcards, regex, level/difficulty filters.

## Sorting + pagination

- Default sort is relevance (exact-code > prefix > title-phrase > title > instructor > area > description, with a small boost for registrable sections).
- Every list returns `total_count` + `next_offset` + `has_more` + `snapshot_id`. State "N of M" to the user; re-call with `next_offset`. (CLI names the total `total`; MCP names it `total_count`.) If `snapshot_id` changes between pages, the data rotated mid-page — restart the walk.
- An offset past the end returns zero hits with a `hint` naming the total, which is different from a true empty result.
- Hits are compact and include `meetings[]`, `credits`, and `potential_error`. Call `get_classes` for descriptions, dates, and seat detail.

## Recipes

1. Morning MWF: `{days:["M","W","F"], ends_before:"12:00"}` / `5c search --days MWF --before 12pm`.
2. No-prereq intro: `{query:"intro"}` then read `get_classes` descriptions; presence of a section implies nothing about prerequisites, and no mention of them means unknown.
3. Cross-college same number: `{query:"CSCI 62"}` then label PO vs HM hits separately.
4. Instructor lookup: `{instructor:"Rankin"}` / `5c search --instructor rankin`.
5. Open seats, afternoons: `{starts_after:"13:00", availability:"has_seat"}`.
6. Exclude a fixed class: `5c search --dept CSCI --exclude-conflicts-with "MATH 032 PO-01 FA2026"`.

## Known quirks

- Over-enrolled rows (`filled > total`) are normal. A closed section with spare capacity stays Closed; `--open` excludes it and `seats_open` still reports the number.
- `R` (Reopened) means the registrar reopened it — trust `status`, not arithmetic.
- `TBA` meetings never satisfy day/time filters and are never conflict-checked. A check containing a TBA section returns `complete: false` with the ID in `skipped_tba`.
- Half-semester sections only conflict when date ranges overlap.
- Summer terms are sparse; some years lack `SU` entirely.
- Coverage: HyperSchedule carries the 5C registrars' own catalogs. Instructor names, prerequisites, and seat counts are only as fresh as the last snapshot; coverage notes live in ids-and-terms.md.
