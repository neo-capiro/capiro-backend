# Stage 2 s2-recheck-adapter (2026-10-06)

Source: main `fd6a8b557e349404ca7fae3847a80ae84bc5f202`.

Research producer-input re-check adapter (#2051): governed Context Plane inputs and handoff attachments are pinned at publication and re-checked against their canonical owners on every report read; unsupported input classes stay refused and are logged by category. Also carries #2047 (hearing capture debrief fix, merged by another workstream). No migration.

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:3071831dea97…` | `a35a89a7-8d1b-43ca-bb2e-d8eb93023af1` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
