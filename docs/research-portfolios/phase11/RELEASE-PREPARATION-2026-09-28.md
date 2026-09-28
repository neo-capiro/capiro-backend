# Research Portfolio release preparation — 2026-09-28

Neo authorized integrating the verified correction into local main and GitHub main and shipping through GitHub Actions. The earlier correction record remains historical evidence. No merge or deployment has occurred at this checkpoint.

The stale business-development test harness now passes tenant settings into its simulated transaction and retains the mock object type until the service constructor boundary. Product runtime and tenant authorization are unchanged.

- Full API typecheck: PASS, exit 0 across the complete chained command, including the safety verifier and final Legiwatch configuration.
- Business-development fixture regression: PASS, five tests in one suite, exit 0. Mock isolation tests do not establish live database RLS acceptance.
- Original defense correction validation remains recorded in QUALIFICATION-RECOVERY-CORRECTIONS-2026-09-28.md; its previous API typecheck blocker is superseded by this result.

Release remains BLOCKED by other repository gates and the active database reconciliation hold. The migration-recovery and Meri-foundation owners are coordinating prerequisites. This branch does not incorporate their unverified migration or formatting work. No SQL, ledger, shared database, routing, activation, cohort, or model changes were made. The occupied local main and its unrelated dirty files remain preserved. Production canaries remain user-run. Research Portfolios full acceptance remains NO-GO.

Evidence: C:/dev/defense-ship-20260928/api-typecheck-fixture-repair.log and fixture-regression.log, with corresponding stderr logs. The user-facing release report will record the eventual integration and deployment separately.
