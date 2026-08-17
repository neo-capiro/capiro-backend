# Phase 8 Defense API — Session 4 handoff

## Verdict

**Implementation milestone complete; Session 4 acceptance remains blocked by the real FY27 behavioral replay and the missing Session 3 route implementation.**

This branch implements Workstream F's dark source/composition boundary without merging, deploying, applying a migration, moving traffic, changing schedules, activating a snapshot, or promoting canonical data.

## Repository coordinates

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session4-runtime-move`
- Base: `67f220efe3065f21676c14ec31b65ee5312d93e5`
- Source owner retained during strangler: `apps/api`
- Target owner prepared dark: `apps/defense-api`

## Important prerequisite finding

The previously referenced Session 3 branch did not contain the claimed 49-route Program Elements implementation or a pull request. It contained four partial scaffold commits only. Session 4 was therefore based on current `main`, and this handoff does not claim that the Workstream E gate is satisfied.

## Delivered

1. Exact Git-tree mirrors under `apps/defense-api/runtime-source` for:
   - the complete Phase 1–7 `defense-budget` source lineage;
   - Program Element snapshot/source-document/delta lineage;
   - Program Element change-outbox lineage;
   - read-only Phase 6 composition and Phase 7 planning/status operator entrypoints.
2. A compiled, provider-neutral `Phase17RuntimeCoordinator` that composes:
   - source profile;
   - parser artifact;
   - semantic extraction;
   - Phase 2 verification;
   - projection plan;
   - Phase 6 certification;
   - Phase 7 eligibility;
   - promotion inspection;
   - outbox status.
3. The coordinator is inspect-only and exposes no promotion execution or snapshot activation method.
4. A dark Nest module with no controller or public route.
5. Permanent source-tree/blob parity verification.
6. A fail-closed replay-evidence contract for the real FY27 cycle.
7. Unit tests for deterministic lineage hashing, phase ordering and malformed-artifact refusal.
8. Machine-readable runtime ownership/status inventory.

## Permanent commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/auth build
pnpm --filter @capiro/defense-contracts build
pnpm --filter @capiro/defense-domain build
pnpm --filter @capiro/defense-client build
pnpm --filter @capiro/defense-api prisma:validate
pnpm --filter @capiro/defense-api typecheck
pnpm --filter @capiro/defense-api test
pnpm --filter @capiro/defense-api build
pnpm --filter @capiro/defense-api verify:session4
pnpm --filter @capiro/api exec tsc -p tsconfig.budget-extraction-contract.json --noEmit
pnpm --filter @capiro/api exec tsc -p tsconfig.budget-verification-v1.json --noEmit
pnpm --filter @capiro/api exec tsc -p tsconfig.budget-parser-router.json --noEmit
pnpm --filter @capiro/api exec tsc -p tsconfig.phase6.json --noEmit
pnpm --filter @capiro/api typecheck:phase7
git diff --check
```

## Real FY27 replay acceptance

Session 4 may be marked complete only after the same immutable FY27 source inputs are executed through both the retained implementation and the moved composition boundary and an evidence file proves:

- same source SHA;
- same parser provider/model/options identity;
- same extraction hash;
- same Phase 2 verification decision hash;
- same projection-plan hash;
- same Phase 6 certification hash;
- same Phase 7 eligibility hash;
- same promotion-inspection hash;
- zero unexplained differences;
- no canonical mutation.

Then run:

```bash
PHASE8_SESSION4_REPLAY_EVIDENCE=<relative-json-path> \
  node scripts/verify-phase8-session4.mjs --enforce-replay
```

## Open blockers

1. Rebuild and independently accept Session 3's complete 49-route read/mutation surface.
2. Materialize production-equivalent adapters behind `Phase17RuntimePorts` without giving the HTTP task promoter/parser-worker authority.
3. Run and retain the real FY27 replay evidence described above.
4. Resolve any repository-wide GitHub Actions startup outage before relying on remote green checks.

## Explicit mutation statement

- Merge: not performed
- AWS deployment: none
- Production migration: none
- Production/shared data mutation: none
- ALB or traffic change: none
- EventBridge/schedule change: none
- IAM/secret change: none
- Snapshot activation: none
- Canonical promotion: none
- NVIDIA/GPU runtime: none
- Legacy source deletion: none
