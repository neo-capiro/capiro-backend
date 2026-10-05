# Stage 1 s2-release-a (2026-10-05)

Source: main `f39bf04768f2d4906d55c784f16d6c6a82f89f78`.

Stage 2 Release A, API only: jobs foundation shipped dark (#2038): kind, goal_revision and deliverables on research sessions, projected job status, meri.jobs tenant flag (off), lease sweeper (off unless MERI_JOB_SWEEPER_ENABLED=true). Also carries the shared document-request change from #2033. Migration 20281008010000_clio_research_sessions_jobs applied first with Neo's OK.

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:b9924eadcfae…` | `4122e645-4d38-474f-9caa-3a42442f10af` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
## Migration (applied before the roll, Neo's OK 2026-10-05)

| Step | Task definition | Result |
| --- | --- | --- |
| `migrate` on the candidate image | `capiro-dev-api-admin-migrate:85` | exit 0; `Applying migration 20281008010000_clio_research_sessions_jobs`; "All migrations have been successfully applied." (one pending migration) |
| `migration-status` on the candidate image | `capiro-dev-api-admin-migrate:86` (family latest, read-only) | exit 0; "Database schema is up to date!" |

Logs: `migration/migrate-log.txt`, `migration/status-log.txt`.
