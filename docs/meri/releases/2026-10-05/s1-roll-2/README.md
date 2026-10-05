# Stage 1 s1-roll-2 (2026-10-05)

Source: main `94c84fc03d8aee8be4d7e62a5a552c48471cda67`.

Stage 1 roll 2: capture harness out of production code (#2022), 'current' is not a role claim (#2015), budget words need a budget context (#2020). Orchestrator first, then API. Code only; no migrations.

| Service | Image digest | Build |
| --- | --- | --- |
| meriv2-orchestrator | `sha256:90bd98fa6103…` | `76fd8678-171a-49b5-9856-d5d0c47ed27f` |
| api | `sha256:269e68fa51c5…` | `0dff6ed4-a2b4-49ce-872f-6f231507f425` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
