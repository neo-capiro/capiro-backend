# Match-label eligibility state acceptance

Date: 2026-09-25
Base: `a175d787c976820be86d2f7f7fd6911f4d2ac4bf`

## Change

The derived match-label contract now reports mandatory eligibility as `unknown`, `satisfied`, or `failed` separately from the fit label. The orchestrator defaults to unknown and no longer passes unknown requirements as satisfied. Enforce output retains a supported direct-fit label while appending a clear verification caveat when eligibility is unknown; a known failure continues to cap the fit label at conditional. Shadow output stays byte-identical and reports only aggregate eligibility-state counts. No rollout flag or production setting changed.

## Verification

- `pnpm --filter @capiro/meriv2-core exec jest --runInBand src/grounding/match-label.spec.ts` — pass, 12 tests.
- `pnpm --filter @capiro/meriv2-core typecheck` — pass.
- `pnpm --filter @capiro/meriv2-core build` — pass.
- `pnpm --filter @capiro/meriv2-orchestrator exec jest --runInBand src/meri/meriv3/match-label-control.spec.ts` — pass, 11 tests.
- `pnpm --filter @capiro/meriv2-orchestrator typecheck` — pass.
- `pnpm --filter @capiro/meriv2-orchestrator build` — pass.
- `git diff --check` — pass.

## Limits

This change makes the unresolved state explicit and prevents it being logged or presented as satisfied. The pinned caller has no source-backed per-opportunity mandatory-requirement evaluator, so it will report unknown unless a caller supplies a known eligibility state. This change does not add requirement retrieval or establish the accuracy of any eligibility assessment. Match-label rollout remains dark.
