# Stage 1 s1-roll-3 (2026-10-05)

Source: main `27f1ebda1b222daef1d963439a42650e885eb282`.

Stage 1 roll 3, orchestrator only: generated documents keep their outcome and download link in the model-visible result, and classification uses the typed request rather than appended attachment text (#2026). API unchanged (561).

| Service | Image digest | Build |
| --- | --- | --- |
| meriv2-orchestrator | `sha256:7c8f43c82319…` | `48433697-a47b-4522-a146-c7d823c8932e` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
