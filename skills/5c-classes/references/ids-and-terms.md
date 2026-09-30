# IDs and terms

## Canonical section ID

`CSCI 051 PO-01 FA2026` = `{DEPT} {NUM:03d}{suffix} {SCHOOL}-{SEC:02d} {TERM}`.

- `CSCI 051` — department + zero-padded number + suffix (`CSCI 005L` keeps `L`).
- `PO-01` — school affiliation + 2-digit section.
- `FA2026` — term (season + year, HyperSchedule-native).

The CLI/MCP accept loose input (`csci51 po`, `CSCI 051 PO-01`, `CSCI 051 PO-01 FA2026`).
Loose input resolves only when it is unique: `CSCI 50` with two Pomona sections
returns both as candidates (exit 3 / `ambiguous`) rather than picking one. A full
identity with the wrong section number is a miss, never a neighbouring section.

`check` and `check_schedule` require exact IDs — a partial ID fails the whole
audit with the unresolved inputs named.

## College codes

| Code | College | Also accepts |
|---|---|---|
| PO | Pomona College | `pomona` |
| CM | Claremont McKenna College | `cmc`, `mckenna`, `claremont mckenna` |
| HM | Harvey Mudd College | `mudd`, `hmc` |
| SC | Scripps College | `scripps` |
| PZ | Pitzer College | `pitzer` |

Joint/intercollegiate affiliations pass through: `KS` Keck Science, `JP` Joint
Program, `JT` Joint Taught, `JM` Joint Music, `AF`/`CH`/`AA` intercollegiate.

Three facts are distinct and are never collapsed into one:

- **Affiliation** (`identifier.affiliation`) — which college's catalog the code
  belongs to. The canonical ID uses this.
- **Primary association** (`course.primaryAssociation`) — the home campus.
  Cross-listed courses differ between the two.
- **Eligibility** — who may actually register. The registrar decides; a shared
  code or a joint affiliation is not evidence that any 5C student can enroll.

## Term codes

`FA2026` Fall 2026 · `SP2026` Spring 2026 · `SU2026` Summer 2026 (sparse).

Accepts `FA26`, `Fall 2026`, `fall26`, `2026FA`, `F26` (Pomona CX form `2026;FA`
also parses). Relative terms ("next semester", "last fall") → call `list_terms`
first and state which term you searched.

Terms are validated against `/v4/term/all`. A term the registrar has not
published is `E_TERM_NOT_FOUND` / exit 2 with the available terms attached —
deliberately not a substitution, because an answer about the wrong term is worse
than no answer. Opt in explicitly to serve the newest available term:
`allow_term_fallback: true` (MCP) or `--fallback-term` (CLI). The response then
carries `fallback: {requested, served}` and a warning naming both terms.

## Coverage

HyperSchedule v4 mirrors the 5C registrars' published catalogs: course code,
title, description, instructors, meeting times/locations, credits, course areas,
status, and seat counts, plus per-term offering history. Verified against
`/v4/sections/FA2026` and `/v4/term/current` on 2026-09-27.

What that does and does not cover:

- Cross-registration and joint programs appear under their own affiliation codes
  (`KS`, `JP`, `JT`, `JM`, `AF`, `CH`, `AA`) and graduate offerings under `CG`.
  A code in a joint catalog is not a guarantee of registration eligibility.
- Prerequisites are free text inside `description`. Absent text means unknown.
- Seat counts are the registrar's snapshot, refreshed into the local cache with a
  60-second TTL for seats. They are never a promise of enrollment.
- Rows whose canonical ID collides with an earlier row (for example two
  half-semester rows collapsing onto one ID) are dropped at ingest and counted in
  `duplicate_ids`; rows that fail validation are dropped and counted in
  `quarantined`. Both counts travel with every result and mean "coverage is
  incomplete", not "nothing is wrong".
