# Stage 2 s2-recheck-d2 (2026-10-06)

Source: main `006eb59d2fa5fdead32a9b0e40e11ccdf17592c2`.

Source re-check executes each distinct owner read once, four at a time (#2134); D2 matches quotes against decoded tool text (#2132); the federal evidence snapshot transaction allows 180 s (#2136, for the backfill family). Follows T5 run 10 (ca7158f1).

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:7286985d3b04…` | `65026d9a-4a77-45da-8b25-60ba8c37e27f` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
