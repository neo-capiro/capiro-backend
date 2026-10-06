# Stage 2 s2-coordinator-rereads (2026-10-06)

Source: main `287f437a1725e9e7d4910662f354fef593771cb1`.

Research steps can be re-read after they complete (#2067): the durable coordinator admits a further read of a completed step before refusing, so a step a bounded child completed (or another source of the same step) no longer blocks the parent; dependency order still holds for first reads. Built from main 287f437a1, which also carries LegiWatch #2066 (its branch commit 7235fb172 was live as API 584). No schema change since the last migration-status check (admin-migrate 89). No migration applied.

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:dcf3c4a2ba16…` | `2b661e5c-f5e5-4002-95d8-0a9321856dac` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
