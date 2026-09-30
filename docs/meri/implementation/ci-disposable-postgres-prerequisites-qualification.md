# Disposable PostgreSQL baseline prerequisites

Funding Opportunities and Phase 8 database rehearsal failed on focused head `f292e02572e13a441d59dfbadf0b1e96d5be1b43` because migration `20281002010000_research_portfolios_phase10_watch_delivery` grants privileges to the externally provisioned `capiro_worker` role. The migration also requires the existing append-only trigger helper. Funding run `36506930454` / job `109210328155` and Phase 8 run `36506930499` / job `109210328606` contain the direct failure evidence.

The role SQL is extracted byte-for-byte from the existing disposable bootstrap. Its canonical attributes remain NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOBYPASSRLS and NOREPLICATION. Unsafe existing attributes or membership in either direction fail closed. The fixture adds no grants or memberships; application migration grants remain unchanged.

The fixed original bootstrap still targets postgres at loopback port 5432 and database capiro. Funding applies the same prerequisite SQL to its three owned databases on port 5486, with explicit GitHub Actions/CI/disposable markers, loopback connection pinning and connected-identity validation. Phase 8 applies prerequisites only through the container created by its own invocation. Its external URL path receives no new prerequisite calls. Both already provision the historically required capiro database, so database names and migration SQL are unchanged.

## Qualification

- **PASS:** A fresh native PostgreSQL 16.15 cluster was initialized under `C:/dev/cap-meri-foundation-evidence/db-prerequisite-qualification/attempt2/data`, bound only to `127.0.0.1:55449`, and stopped after testing. Existing port 55433 was not used or modified. The overall qualification harness exited 0.
- **PASS:** The actual unmodified Phase 10 migration reproduced the missing-role error (expected exit 3), then applied with exit 0 after the shared prerequisites. This component test used explicitly minimal parent tables for its foreign keys; it is not a complete prior-schema replay.
- **PASS:** Role creation and idempotence; all seven unsafe attribute variants; incoming and outgoing memberships; unchanged compatible function identity/definition; incompatible function refusal without replacement; append-only UPDATE/DELETE refusal; own-tenant read and foreign-tenant withholding; worker UPDATE/DELETE permission denial. Positive commands exited 0; expected rejection commands exited 3 and matched their required errors.
- **PASS:** 22 Node tests exited 0 with no failures or skips: nine existing bootstrap tests, eight invocation guard tests and five existing PGlite prerequisite tests. The complete Phase 8 external path is tested with fake database/migration commands; it does not contact an external URL.
- **PASS:** Bash syntax checks and patch applicability checks. Existing acceptance gates and minimum test counts are preserved. Only fixture-file trigger coverage was added.
- **PASS, static scope:** Separate Hermes/Kimi review on AWS Bedrock `moonshotai.kimi-k2.5` completed with actual exit 0 for the unchanged six-file production proposal. It did not claim dynamic release qualification.
- **BLOCKED, setup:** The unchanged 445-migration Prisma replay exited 1 at the first migration because the installed native server has no `vector` extension. No extension was installed, migration edited, error bypassed or ledger repaired. Hosted workflows use the existing pgvector image and still require a successful full replay.
- **NOT RUN:** Hosted Funding and Phase 8 acceptance with this change; deployed-service acceptance.

The native run recorded 48 successful commands, 15 expected rejection commands and one blocked full-replay command. The initial cluster start encountered a Windows inherited-output-pipe harness timeout; that owned process was stopped, logs retained, and a fresh second cluster used file-backed logs successfully. This setup failure is separate from source defects.

Evidence is retained under `C:/dev/cap-meri-foundation-evidence/db-prerequisite-qualification/` and the exact independently reviewed proposal under `C:/dev/cap-meri-foundation-evidence/db-prerequisite-proposal/`. No AWS databases, application tenants, deployment configuration or production roles were changed by qualification.
