# Required Phase1 caller mode

The root `verify:engagement-phase-1` command omitted the `--run` required by its existing runtime helper and therefore stopped at the helper's usage exit. This slice adds that single operand. Accepted source is `2496e57b4193cdd4d004232711a77ef707ae6b98`, tree `ed4f162b3b59dbc27b3757170073e88be0181f35`, based on preserved PR2412 `6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`.

The helper, argument gate, Phase2 nested caller, local wrapper and all six remaining `node --check` operands are byte-exact. All other package values and 21,044 baseline paths remain unchanged. Independent review `341004160ab3361ad3fe44e2db5c937d0be045a3` accepted 16 inert preflight controls and the actual cached Phase1 CLI refusal/usage test. Its explicit run probe denies the first child operation before running any command; it is not full closeout acceptance.

The original missing-operand assertion failure and local TSX-resolution setup failure remain preserved. With cached dependencies the broader existing four-case smoke suite is three PASS/one RED: the root/Phase1/local-wrapper assertions pass, then existing Memory operator documents fail because their manual commands also omit `--run`. Those three documents remain unchanged pending ownership coordination; no test is weakened or full-suite success claimed. Raw failing TAP retains its whitespace, with the original diff-check qualification.

This one-path source slice overlaps the registry-control draft only at `package.json`, in a different command entry. Compose both reviewed histories and verify both command values. The three operator mirror repairs are disjoint. Candidate/declared production newsletter history is not automatically restored by this caller correction.

No application/public HTTP/DTO/schema/migration contract, permission, default, provider or entrypoint identity changes. No full Phase1 closeout, database/migration, real child workload, provider, message, upload, paid model, AWS, native generation/download, deployment or main merge was performed. Native/full Cleanup acceptance and 123 deferred clock samples remain open.
