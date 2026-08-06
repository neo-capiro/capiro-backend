# Phase 5 Audit-Repair Handoff

## Release unit

- Repository: `neo-capiro/capirov2`
- Branch: `agent/pe-phase5-audit-repairs`
- Base at branch creation: `f626288c324181b2523b7d2bccf3f1429216bba4`
- Merge method: manual squash merge after exact-head closeout
- GitHub Actions: unavailable and not accepted as evidence

## Why this repair exists

The original Phase 5 A–O implementation was already present in `main`, but the independent audit found that it was not acceptance-complete. The confirmed gaps were:

1. no native additive Prisma schema/migration for Procurement, O&M, and MILCON;
2. no complete operator command surface;
3. no executable TypeScript/Python/Prisma/container closeout;
4. “negative controls” were probes rather than mutate-fail-restore controls;
5. artifact builders could manufacture manual parser provenance when called without parser runs;
6. MILCON identity and composition omitted appropriation/account and could collapse projects;
7. projection source observations carried empty assertion/evidence ledgers;
8. projection used document-level verification decisions without independently requiring accepted assertion IDs;
9. a required document could emit an empty structurally valid artifact and appear successful.

## Closed correctness defects

### Exact parser-result proof

`non-rdte-proof-bound-artifact-v1.ts` now requires every operator-path artifact to bind to an exact persisted Phase 3 parser result:

- strict result contract and content SHA;
- source SHA;
- parser method/version/config SHA;
- result content SHA as parser-run output SHA;
- exact successful page coverage;
- evidence page coverage;
- optional independently loaded parser-result byte SHA.

Empty parser ledgers, synthetic manual runs, missing proof, tampered result content, and page/source mismatches fail closed.

### Proof-bound semantic factory

`non-rdte-semantic-artifact-factory-v1.ts` is the supported operator path for all ten exhibits:

- P-1
- P-40
- P-5/P-5A
- P-21
- P-3A
- O-1
- OP-5
- C-1
- DD1391

It consumes Phase 3 results and supplies real parser runs to the existing pure builders. The builders’ test fallback cannot satisfy the proof boundary.

### Required-document completeness

`non-rdte-document-completeness-v1.ts` blocks:

- required empty artifacts;
- incomplete required source-fact coverage;
- missing expected native line kinds;
- manifest/artifact identity mismatch.

### Account-complete MILCON identity

The backward-compatible `milcon-native-identity-supplement-v1.ts` joins the Phase 1 MILCON identity with the manifest-owned appropriation/account. Both family composition and projection use:

```text
MILCON_PROJECT = component + account + project number + location context
```

The same project at the same installation in different appropriations remains distinct. Fuzzy title matching is not permitted.

### Assertion-level trusted projection

`non-rdte-proof-bound-projection-planner-v1.ts` requires:

- exact parser-result proof;
- exact Phase 2 result matching artifact/source/candidate/run/decision;
- accepted assertion IDs that actually exist in the artifact;
- no assertion that is both accepted and rejected;
- nonempty assertion/evidence ledgers for all candidates;
- account-complete MILCON identities.

Rejected or unaccepted assertions are removed before the original pure planner runs. Candidate IDs and plan content SHA are recomputed after normalization.

## Native additive schema

Migration:

```text
20260818030000_non_rdte_phase5_projection_schema
```

Dedicated validation schema:

```text
apps/api/prisma/non-rdte-projection/schema.prisma
```

Added native concepts:

- `procurement_budget_line`
- `procurement_budget_line_year`
- `procurement_distribution_line`
- `procurement_detail_fact`
- `om_sag`
- `om_sag_year`
- `om_detail_fact`
- `milcon_project`
- `milcon_project_year`
- `milcon_detail_fact`
- `non_rdte_budget_line_source_observation`
- `non_rdte_budget_line_relationship`

The migration is additive and contains no canonical data load or backfill. It does not reference `program_element`. Proof-bound rows require source document, artifact SHA, assertion, verification candidate/run/decision, source PDF SHA, and nonempty evidence IDs.

## Operator commands

The branch provides executable local commands for:

1. manifest inspection;
2. semantic extraction from Phase 3 results;
3. merged Phase 2 trusted verification;
4. family composition/certification;
5. read-only projection planning.

See `docs/runbooks/defense-budget-non-rdte-cycle.md` for exact arguments and map contracts.

No command accepts `--commit`. Phase 5 does not instantiate a Prisma writer or paid parser client.

## Permanent validation

One-command closeout:

```bash
pnpm --dir apps/api exec tsx \
  scripts/verify-pe-budget-phase-5-closeout.ts \
  --include-containers
```

It includes:

- merged Phase 1–4 closeout;
- Phase 5 family/proof/projection/operator tests;
- strict Phase 5 TypeScript;
- primary and dedicated projection Prisma validate/generate;
- 20 actual mutate-fail-byte-restore controls;
- disposable PostgreSQL 16 fresh and pre-Phase-5 upgrade paths;
- locked Python parser Ruff/mypy/pytest;
- parser containers through the inherited Phase 3/4 closeout;
- formatting and `git diff --check`.

The matrix empties AWS and LlamaParse credentials. It does not access AWS, a paid provider, or a shared database.

## Migration rehearsal assertions

The disposable PostgreSQL rehearsal proves:

- full fresh migration chain reaches all Phase 5 tables;
- pre-Phase-5 upgrade applies cleanly;
- legacy Program Element data survives unchanged;
- the migration creates zero Procurement/O&M/MILCON rows automatically;
- money retains six-decimal precision;
- same MILCON project/location across two accounts remains distinct;
- empty evidence ledgers reject;
- non-explicit relationships reject.

## Safety confirmation

This repair branch has performed no:

- merge to `main`;
- deployment;
- AWS infrastructure or service change;
- shared/production migration application;
- paid parser call;
- production source parse;
- canonical Procurement/O&M/MILCON/Program Element write;
- legacy data migration or backfill.

## Remaining Phase 7 work

Phase 7 still owns:

- transactional projection-plan execution;
- generated Prisma writer adapters;
- idempotent insert/update/supersession semantics;
- promotion authorization and rollback controls;
- legacy procurement migration/backfill decision;
- read-path cutover to native tables;
- production data promotion and post-promotion certification.

Phase 5 merge readiness does not authorize or imply those actions.

## Merge decision

The branch is eligible for manual squash merge only after the exact branch head completes the closeout command with exit code 0. Since GitHub Actions is unavailable, the command output is the release evidence. Deployment and migration application remain separately authorized post-merge actions.
