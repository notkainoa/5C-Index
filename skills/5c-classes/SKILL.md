---
name: 5c-classes
description: Search the Claremont Colleges (5C: Pomona, Claremont McKenna, Harvey Mudd, Scripps, Pitzer) course catalog; check seats, prerequisites, sections, schedules, and terms. Use when the user asks about 5C courses, schedules, enrollment/seats, prerequisites, conflicts, or course history.
license: MIT
compatibility: Tools ship on npm — CLI via `npx 5c-cli@latest` (`npm i -g 5c-cli` puts `5c` on PATH), or the 5c MCP server (host config `npx -y 5c-mcp`). Node 20+; network access to fetch 5C Index snapshots.
metadata:
  author: 5C Index
  version: "0.4.0"
---

# 5C Classes

Search the 5C course catalog (Pomona, CMC, Harvey Mudd, Scripps, Pitzer) via the 5c tools.

## When to use

- Finding courses by keyword, subject, college, term, time/days, instructor.
- Section details: meeting times, instructors, prerequisites, descriptions.
- Seat/enrollment checks, term listings, "was X offered in term Y?", schedule conflicts.

## When NOT to use

- General knowledge, poetry, advising opinions — answer without tools.
- Registration/enrollment actions — read-only. Report seats, point to the portal.

## Available tools (5c MCP server; CLI twins in parentheses)

- `search_classes` (`5c search`) — discovery. Filters: schools, departments, days, time window, instructor, areas, credits_min/max, availability, conflict exclusion, sort, explain. Unknown params are rejected (-32602). Every hit carries `meetings[]`, `credits`, and `potential_error`, so most answers need no second call.
- `get_classes` (`5c get`) — full detail for 1–20 IDs. Unknown IDs come back in `not_found`; loose IDs that match several sections come back in `ambiguous` — ask the user, never pick for them.
- `check_schedule` (`5c check`) — audit 1–20 IDs: conflicts, travel warnings, credits, seat problems, `weekly_grid`. The server does all time math; never compute overlaps yourself. Read `ok` **and** `complete`.
- `list_terms` (`5c terms`) — resolve "next semester"/"last fall" before searching. Cache per session.
- `get_course_history` (`5c history`) — past offerings + a `verdict` stated from the window actually observed.

Every tool declares an output schema, so the documented shape is the validated shape.

## Golden paths

1. **Discovery → detail:** `search_classes` → present top hits with IDs → `get_classes` on the pick.
2. **Enrollment check:** `search_classes` → `get_classes`. Quote `fetched_at` ("as of …") and the `stale` flag.
3. **Conflict check:** `check_schedule` on candidate IDs → report overlaps, travel warnings, seat problems, and whether the audit was `complete`.

## ID conventions

- Canonical ID: `CSCI 051 PO-01 FA2026` (dept + zero-padded number + school-section + term). Never invent IDs. Always search first; pass IDs verbatim.
- Loose input resolves only when it is unique. `CSCI 50` with two sections returns both candidates.
- Same number at different colleges = different courses — always label the college.
- School codes: PO Pomona, CM Claremont McKenna (`CMC` accepted as alias), HM Harvey Mudd, SC Scripps, PZ Pitzer (+ joint: KS, JP, JT, AF, CH, JM, AA; CG Claremont Graduate).

## Rules

1. Prerequisites, times, instructors, seats come ONLY from tool output. Never infer. An absent prerequisite mention means unknown, not "none".
2. Empty result = "not found" + the returned `suggestions`. Never fabricate a course.
3. Seats are a snapshot: state `fetched_at` ("as of …") and warn when `stale` is true. Never promise enrollment or hold seats. Tell users to verify in CX before enrolling.
4. `status` O/R means the registrar says registrable. Capacity (`seats_open`) is reported separately and is never proof of eligibility.
5. Ambiguous term ("next semester") → `list_terms` first, state the term you searched. An unpublished term is an error listing available terms — do not substitute silently. Pass `allow_term_fallback` / `--fallback-term` only if the user accepts another term, and say which term you served.
6. If `potential_error` is true, tell the user the source data may be unreliable.
7. `quarantined` or `duplicate_ids` above zero means the snapshot is incomplete or collapsed. Say so instead of presenting the list as complete coverage.

## Recommending

When the user asks for options ("what should I take?", "find me something that fits"):

- Keep hard constraints hard: college, term, days/times they cannot move, credit load, seat availability. Relaxing one silently is the most damaging mistake here.
- If you relax anything, name it: "no MWF section fits 10:00–12:00, so this list includes TR options."
- Distinguish course from section from lab/discussion. Offer a different section before offering a different course.
- Never rank by perceived quality, difficulty, or prestige. Rank by the user's stated criteria, and say which criterion you sorted by.

## Error handling

| Signal | Action |
|---|---|
| Unknown course/ID | `search_classes` with fewer filters; offer `not_found` + `suggestions` |
| `ambiguous` in `get_classes` | List the candidate IDs and ask which; never choose |
| No seats field | Say "seat data unavailable", not "open"/"full" |
| `stale: true`, or fetch failure | Warn, retry once, report the last snapshot with its timestamp |
| `E_TERM_NOT_FOUND` / exit 2 | Term not published. `list_terms`, then search a real term — or use fallback only with consent |
| Rejected params (-32602) | Unknown param name — use `availability` (not `open_only`), `instructor` (singular), `credits_min`/`credits_max` |
| `5c` not on PATH / command not found | Run commands as `npx 5c-cli@latest <args>` — downloads once, then cached. Ask before `npm i -g 5c-cli` |

## Examples

**Seats:** "Is HM CSCI 62 open?" → `search_classes(query="CSCI 62", schools=["HM"])` → `get_classes` → "2 seats available, status Open (as of 2026-09-24 09:10 PT). Register via the portal."

**Prereqs:** "Prereqs for CMC ECON 101?" → resolve via `search_classes` → `get_classes` → quote the description verbatim. If it names none, say the listing does not state prerequisites.

**Conflict:** "Do PO MATH 55 and HM PHYS 41 overlap?" → `check_schedule` on both IDs → report the conflict plus `complete` ("both sections have known times, so this audit is complete").

**Ambiguous code:** "Find CSCI 50" → two sections. Present `CSCI 050 PO-01` and `CSCI 050 PO-02` and ask which, or show both.

## Further reading

- Full filter grammar, college codes, sorting, recipes: [search-syntax.md](references/search-syntax.md)
- ID format + term-code table: [ids-and-terms.md](references/ids-and-terms.md)
- Error playbooks: [troubleshooting.md](references/troubleshooting.md)
