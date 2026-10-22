# A1 #106 Google provider fixture correction

Reviewer re-review of remote `6b58d0e6` (relayed by the coordinating parent, not rerun locally) reported the canonical API typecheck back at its 62-error baseline, the earlier 57 engagement regressions gone, and 13 mutants killed. Its only new engagement failure was the Google OAuth start contract fixture missing `integrationConnection.findMany`.

The local correction changes only `makeOAuthService` in `apps/api/src/engagement/google/google-provider-contract.spec.ts`:

- Add `integrationConnection.findMany: jest.fn(async () => [])`, modelling no reusable Add placeholder.
- Make `$queryRaw` a mock returning the existing membership row only for the `tenant_memberships` read, and an empty result for the advisory-lock query.

The review recipe's unconditional empty `$queryRaw` result needed this adaptation on the current tree: `GoogleOAuthService.start` first calls `assertActiveMailboxActor`, which requires the existing membership row. Production code and authority guards were not changed.

Local source checks: 10 test declarations and 20 `expect` calls before and after; every existing `expect` source line is identical; `git diff --check` passes. Source SHA-256: `4e0f4d3aac6854b1199d639b39a49f3bf8c05241cce2a14ffa58ec9ae8e39c3c`.

The targeted canonical command used the unchanged `apps/api/jest.config.cjs`, `--runInBand`, and `--runTestsByPath apps/api/src/engagement/google/google-provider-contract.spec.ts`, with its cache in `/dev/shm`. It exited 1 after 5 seconds before collecting any tests: `Cannot find module 'sanitize-html'` from `jest.native-runtime-environment.cjs`. Zero tests ran. Raw result, log and Jest JSON are `/dev/shm/a1-mail-r2-google-canonical*`; the compact JSON alongside this note preserves the receipt. The local overlay also lacks `@azure/msal-node`, but this attempt stopped at the sanitizer import. No dependencies, mocks for the canonical environment, or test-configuration changes were added. No local canonical test or typecheck pass is claimed.

This fixture correction does not change production ML-09, send/recovery code, SQL, merges or deployments. Other authorized R2 work is coordinated separately.
