# Stage 1 s1-roll-4 (2026-10-05)

Source: main `24325c5ee61a01b939fcb51d8cb7012a58857466`.

Stage 1 roll 4, orchestrator only: a request that names a slide or page is a targeted read, attachment text never classifies the request, and a strategy deck is not a request for advice (#2033, case 41). API unchanged (561); it only uses the shared resolver for file-location clarifications and picks the change up at its next roll.

| Service | Image digest | Build |
| --- | --- | --- |
| meriv2-orchestrator | `sha256:0b34a44e62bf…` | `c45265cd-2bfa-4922-bbe9-0eb4446f0a09` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
