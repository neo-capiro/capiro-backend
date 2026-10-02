PASS

The diff introduces `case01ExecutionSetupPostSeed` as a fifth guarded one-shot CAS operator that correctly handles the SQLSTATE 23514 boundary failure during `PREVIOUS_SEED`. It reuses the existing `projected:true` post-approval state guard, requires exact fourth claim validation, enforces zero correction candidates, verifies current 9-kind CHECK constraints and trigger guards, then completes the lifecycle without re-invoking first approval or projection.

Key safety controls verified:
- **Authorization**: `memoryAuthorization.evaluateInTx` validates reviewer `approve`/`revoke` authority pre-flight; tenant/user isolation enforced via `withTenantUser`.
- **Idempotency**: All five claim keys (`case01ExecutionSetup` through `case01ExecutionSetupPostSeed`) include immutable historical claim chains in final CAS; `FINAL_CLAIM_CHANGED`/`EXISTING_OPERATION` block replays.
- **SQL correctness**: `versionSourceKindCheck` and `versionPayloadCheckSha256` hardcode exact catalog definitions; guards verify `validated=true` and `enabled='O'` before admission.
- **Test coverage**: New PG tests reproduce P2010/23514, verify guard repairs, assert no double-approval/projection, and confirm embedding count remains 1 across full lifecycle.
- **Packaging**: Dockerfile COPY graph frozen; `case01-memory-packaging.test.mjs` verifies exports.

No credential exposure, no new public API surface, only additive migration allowed by policy.