# Source Migration Recovery: Inventory and Guardrail Design

Date: 2026-09-28
Frozen commit: 42942dedad59382f4b4aac6f904b9aee0e02efa6
Worktree: C:\dev\cap-db-incident-recovery (recovery/db-incident-20260928)
Status: CONTAINED — RECOVERY INCOMPLETE — MIGRATION-BEARING RELEASES BLOCKED

## 1. Source manifest

Full migration inventory computed at outputs/source-manifest-raw.json across
6 Prisma migration trees:

  apps/api/prisma/migrations                     445
  apps/intel-api/prisma/migrations                 61
  apps/api-strategy/prisma/migrations               16
  apps/onboard-api/prisma/migrations                 4
  apps/workspace/prisma/migrations                  13
  apps/api/prisma/phase6-projection/migrations        4
  ----------------------------------------------------
  Total                                             543

Each entry records migration name, service, SHA-256 of exact LF SQL bytes, and
file size. Computed from working tree at the frozen commit.
