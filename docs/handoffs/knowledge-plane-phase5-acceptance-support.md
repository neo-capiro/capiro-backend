# Knowledge Plane Phase 5 — Acceptance Support Handoff

## Purpose

This handoff contains non-schema Phase 5 closeout work implemented on a separate branch so it can be integrated without overwriting the dirty local `agent/phase-5-closeout` worktree.

Primary acceptance authority remains:

- `docs/plans/knowledge-plane-phase5-meri-compat-closeout.md`
- the uploaded Knowledge Plane / Meri compatibility adjustment specification

This work does not implement Meri retrieval, Phase 6 extraction, embeddings, graph changes, or production backfill.

## Branch and range

```text
branch: feat/phase-5-acceptance-harness-support
base:   34f110362e1083a7831861007d7d0ee8fa7abe6c
head:   fee3860a36d5baf172975f8b1edf7e92c9df643e
```

The range is six commits ahead of the compatibility base.

Integrate after preserving local dirty work:

```bash
git status --short
# Commit or stash the current Phase 5 closeout changes first.

git fetch origin --prune
git log --oneline --reverse 34f110362e1083a7831861007d7d0ee8fa7abe6c..origin/feat/phase-5-acceptance-harness-support
```

Then cherry-pick only commits not already present, oldest to newest.

## Implemented

### Actual-observation evaluator adapters

`entity-resolution-acceptance-observation.ts` converts real orchestrator output into:

- `EntityResolutionGoldenObservation`
- `MeriCompatibleEntityResolutionObservation`

The DB-backed acceptance harness should use these helpers instead of hand-building perfect observations.

### External-company acceptance fixture providers

Test-only providers cover:

- `Victory Six` → `Victory Six, Inc.` from the `public_web` stage
- misspelled `Kindetic Industries` → `Kinetic Industries, Inc.` from `public_web` plus model candidate reconciliation

Both remain candidate-only. They are fixtures, not production mappings.

### Same-name person fixtures

`JANE_SMITH_GOLDEN_FIXTURES` creates two distinct Jane Smith identities with the same exact alias. Only the intended Example Defense record owns `jane.smith@example.com`.

Expected outcomes:

- name-only `Jane Smith` → ambiguous
- exact email → Example Defense Jane Smith

### Structured authoritative public fallback providers

Read-only exact-source providers now cover available repository data for:

- Congress members / Bioguide / LIS
- Congress committees
- Acquisition Personnel / Directory person IDs
- Program Element codes
- Federal Contractor UEI / contractor ID
- USAspending recipient ID via Federal Contractor
- LDA client ID
- SEC CIK

All canonical writes remain behind `CanonicalEntityRegistrationService`.

Unsupported-but-recognized identifier types report `unavailable` or `partial` rather than falsely reporting complete coverage. Current explicit gaps include source support for CAGE, SAM entity ID, LDA registrant/lobbyist IDs, and some state-person IDs.

### Authoritative identifier precedence

`AuthoritativeFirstUniversalEntityResolutionOrchestratorService` is exposed through the existing `UniversalEntityResolutionOrchestratorService` DI token.

When a request contains both a query and identifiers:

1. supplied identifiers are resolved first;
2. any resolution, ambiguity, or candidate from the identifier path takes precedence;
3. name/alias lookup runs only when the identifier path is genuinely unresolved with zero candidates.

This prevents an exact name from silently winning over a conflicting authoritative identifier.

### Bounded replay verifier

`apps/api/scripts/verify-canonical-backfill-replay.ts`:

- runs the same bounded data-bearing tenant cohort twice;
- snapshots visible canonical entities, aliases, identifiers, resolutions, and cursor;
- fails on new replay entities/aliases/identifiers, duplicate keys, changed deterministic selections, or cursor drift;
- refuses zero-row cohorts;
- is manual only and unscheduled.

Example:

```bash
pnpm --filter @capiro/api exec tsx scripts/verify-canonical-backfill-replay.ts \
  --tenant <uuid> --source client --limit 10
```

## Integration with the existing local DB-backed harness

Update `apps/api/scripts/verify-phase5-db-backed-harness.ts` to:

1. seed `JANE_SMITH_GOLDEN_FIXTURES`;
2. pass `createMeriCompatibilityFixtureProviders()` to the orchestrator for external-company acceptance fixtures;
3. invoke the real orchestrator for every golden/compatibility case;
4. derive observations using:
   - `toEntityResolutionGoldenObservation`
   - `toMeriCompatibleEntityResolutionObservation`
5. evaluate actual observations with the existing evaluators.

Do not hard-code pass results or manufacture observation objects.

## Required verification after integration

Run the local closeout gates already defined in the main Phase 5 handoff, plus:

```bash
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/knowledge/entities
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/knowledge
```

Rerun the DB-backed harness and require:

```text
coverage = 1.0
status accuracy >= 0.95
resolved-selection accuracy >= 0.95
ambiguity accuracy >= 0.95
external-company resolution success >= 0.90
candidate recall = 1.0
fallback-stage coverage = 1.0
false merges = 0
duplicate entities = 0
privacy leaks = 0
cross-tenant leaks = 0
```

Then run the bounded replay verifier against a seeded non-empty cohort and require `report.pass=true`.

## Known boundaries

- No schema/checkpoint migration is included on this support branch; retain the local closeout work for those.
- No production public-web provider is added here. Public/model acceptance providers are test-only. A production provider should implement the existing provider-neutral interface without importing Meri reasoning/tool routing into the Knowledge Plane.
- No merge or deploy is authorized by this handoff.
