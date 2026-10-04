# Case12 pure provider-row extraction — local source qualification

Codex prepared this small extraction after the configured Hermes design-only lane identified the pre-hold planner seam. The Hermes design is preserved separately in `../case12-setup-cost-authority-hermes-v1`; it did not implement or test this change.

`deriveCase12SetupProviderRows({recipe, setupPlan}, native)` returns version, caseId, fixtureNamespace, fixtureInstanceId, tenantId, proposerUserId, reviewerUserId, clientId, setupPlanSha256, recipeSha256, orderedDefinitionSha256, and rows. It verifies the same frozen recipe/setup-plan joins and uses `native.canonicalProjectionSnapshot`. It returns ordinary data only. The caller must establish the source and native read-only task provenance of any plan before cost authority. No reservation, checkpoint, budget price, run, deadline or authority is synthesized.

The full builder preserves its native/envelope validation and output property order. Thirty local tests passed against real compiled native projection/budget functions: full JSON byte equality with frozen baseline, all 510 exact two-provider body hashes and byte counts, no pre-hold fields, clone isolation, and matching malformed-input rejection. Prices, identities and envelope fields in tests are synthetic test data. The 8192 per-model input ceiling and existing arithmetic are unchanged.

No database, provider, cloud, journal or repo writes occurred. This does not qualify a live fixture, setup, cost authority or capture. Final source/image/rates/native plan-task evidence and independent review remain required for the disabled cost-authority owner.
