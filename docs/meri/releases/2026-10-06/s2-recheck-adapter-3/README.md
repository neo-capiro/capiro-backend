# Stage 2 s2-recheck-adapter-3 (2026-10-06)

Source: main `4b14a110994bb148af2503acf81ad978a91d12de`.

Research runs read only through re-checkable tools (#2056): execution admits durable owner reads and audited public-data tools only; bill and web-page reads count as public. Fixes the unreceipted search_research_sources refusal seen on the second live check. No migration.

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:1b0d027ed304…` | `b15a09ae-33e9-472c-a50c-ed64d2526d1b` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
