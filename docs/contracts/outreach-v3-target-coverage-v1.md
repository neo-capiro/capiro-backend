# Outreach V3 Target Health and Coverage Contract V1

## Purpose

Target coverage is deterministic product guidance. It does not use an LLM and does not claim that the selected audience is politically or strategically complete.

## Target health

Per selected target:

- `readyForDrafting`
- `readyForSending`
- stable health codes

Health codes:

- `EMAIL_MISSING`
- `EMAIL_INVALID`
- `ROLE_HISTORICAL`
- `ROLE_UNKNOWN`
- `PROFILE_LIMITED`
- `PROFILE_UNAVAILABLE`
- `DUPLICATE_EMAIL`

A target may be drafting-ready while not send-ready.

## Coverage summary

- selected count
- drafting-ready count
- send-ready count
- staff count
- principal count
- represented chambers
- represented committees
- represented states
- duplicate-email groups

## Gap codes

- `NO_TARGETS`
- `NO_CONTACTABLE_TARGETS`
- `STAFF_COVERAGE_MISSING`
- `PRINCIPAL_COVERAGE_MISSING`
- `CHAMBER_COVERAGE_MISSING`
- `COMMITTEE_COVERAGE_MISSING`
- `STATE_COVERAGE_MISSING`
- `EXISTING_RELATIONSHIP_NOT_PROVEN`

The last gap remains until live relationship analysis is used. The engine does not infer a relationship merely from a target’s existence.

## Snapshot revalidation

The session-scoped coverage API separately returns current-source revalidation for each selected target:

- `current`
- `changed`
- `unavailable`

It includes safe changed-field names and current target snapshot when authorized. Campaign state is never silently updated.

## Non-authority

Coverage does not:

- add recommendations;
- remove targets;
- approve stale roles;
- resolve duplicate emails;
- authorize context;
- make a draft sendable;
- approve or send email.
