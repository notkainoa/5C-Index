# Troubleshooting

## Error catalog

| Signal | Meaning | Action |
|---|---|---|
| `E_USAGE` / exit 2 | Bad flag value (limit, school, day, time, code, block, ID list, >20 IDs) | Read `hint` for valid values; retry corrected. Nothing was fetched. |
| `E_BAD_TERM` / exit 2 | Unparseable term ("next semester") | Terms are canonical (`FA2026`); `list_terms` for valid codes. |
| `E_TERM_NOT_FOUND` / exit 2 | Parseable but unpublished term (e.g. `SP2099`) | `list_terms`, then search a published term. Only pass `allow_term_fallback` / `--fallback-term` if the user accepts being served a different term; the response then names both. |
| `E_NOT_FOUND` / exit 3 | Unknown section ID, unresolved exclusion anchor, or a loose ID matching several sections | `search_classes` with fewer filters; use `suggestions` / `did_you_mean`. For `ambiguous`, ask the user which section. |
| `E_NO_CURRENT_TERM` / exit 1 | Network down and no cached current term | Pass an explicit term, or run once while online. |
| `E_FETCH` / exit 1 | Network/upstream failure, or an ingest swap refused because the payload collapsed | Retry once; then report the last snapshot with `fetched_at`. |
| Empty hits, exit 0 | Query ran, nothing matched | Read `suggestions` first (dept/code guidance); then widen: drop `availability` (`--open`), then days, then schools. Never fabricate. |
| `5c: command not found` | CLI not on PATH | Bootstrap step 3: run `npx -y @kainoa/5c-cli@latest <args>` (downloads once, then cached). Suggest `npm i -g @kainoa/5c-cli` only for many-call sessions, with consent. |

`check` returning `ok: false` is **not** an error: exit 0 means the audit ran and
the schedule has conflicts.

## Empty-result playbook

1. Confirm the term (`list_terms` — the user may mean next semester).
2. Drop `availability` first (`--open` on CLI), then days, then schools.
3. Try the bare code (`CSCI 62`) before keyword guesses.
4. Report "not found" plus the returned `suggestions`, or the ambiguity candidates.

## Ambiguity playbook

- `get_classes` returns `ambiguous: [{input, section_ids}]` when a loose ID matches
  more than one section. Show the candidates and ask; do not pick the first.
- Two sections of the same course at different colleges are different courses.
  Label the college in every answer.

## Stale-seat playbook

- Every result carries `fetched_at` (when this process obtained the snapshot) and
  `stale` (the snapshot is past its freshness window). Seats have a 60-second TTL.
- `stale: true`, or a fetch failure → warn, retry once, report the last snapshot
  labeled with its timestamp.
- Do not use a local clock heuristic (for example "older than 24h"): the tool
  computes the flag for you.
- Never promise enrollment, holds, or waitlist movement. Point to the portal.
- `permCount` = instructor permits issued, NOT a queue position.

## Partial-coverage playbook

- `quarantined > 0`: rows failed validation at ingest and are missing from the
  result. Say "this list may be incomplete" instead of presenting full coverage.
- `duplicate_ids > 0`: rows collapsed onto an existing canonical ID (typically two
  half-semester rows). Mention it when the user is counting sections.
- `check_schedule` `complete: false` with `skipped_tba`: sections without meeting
  times were not conflict-checked. `ok: true` alone never means "fully verified".
- `ok: true` with over-enrolled open sections is still `ok`, but report the
  capacity note ("no remaining capacity, status O") rather than silence.

## `potential_error` playbook

Upstream flags rows with duplicate CX keys, missing instructor/calendar, or
malformed schedules as `potential_error`. Surface it as "source data may be
unreliable" and prefer another section when one exists.
