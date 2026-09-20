# Bundled-skill and dependency license review (Phase 1 ticket W-5)

Closes the item `pins.md` left open: *"Hermes bundles 58 upstream skills into `HERMES_HOME/skills` at first boot; their individual licenses were not audited in Phase 0 and are listed as a Phase 1 review item."*

**Reviewed against the pinned image** `meri-hermes-worker:v2026.9.14-meri` (upstream tag `v2026.9.14`, commit `7a963716b81be13ba513d4f127633b7da493aff2`), by inspecting the seeded filesystem of a running container rather than by reading the source tree — so this reflects what is actually distributed.

## Result: no copyleft, no non-commercial restriction, two attribution obligations

**Outcome: cleared for distribution**, provided the two obligations in §3 are met.

## 1. The 58 bundled skills

`find /opt/data/skills -name SKILL.md` → **58**, across 12 categories (`apple`, `autonomous-ai-agents`, `creative`, `devops`, `email`, `media`, `note-taking`, `productivity`, …).

| Group | Count | License |
|---|---|---|
| Skills with **no** own `LICENSE` file | **53** | Covered by the repository's top-level `/opt/hermes/LICENSE` — **MIT, © 2025 Nous Research** |
| Skills carrying their **own** `LICENSE` | **5** | All **MIT** — see below |

The five self-licensed skills:

| Skill | License | Copyright holder |
|---|---|---|
| `productivity/xlsx` | MIT | Nous Research (2026) |
| `productivity/pdf` | MIT | Nous Research (2026) |
| `productivity/docx` | MIT | Nous Research (2026) |
| `productivity/powerpoint` | MIT | Nous Research (2026) |
| `creative/humanizer` | MIT | **Siqi Chen (2025)** — a third party, not Nous Research |

`creative/humanizer` is the one finding of substance in the skill set: it is third-party MIT code whose **separate copyright notice must be retained**. It is not covered by the upstream project's own notice.

## 2. A second, non-MIT obligation outside the skill set

`plugins/security-guidance/` ships a `NOTICE` stating that it includes work from Anthropic PBC's `claude-plugins-official` repository (`plugins/security-guidance/hooks/patterns.py`, commit `0bde168`, 2026-05-26) under the **Apache License, Version 2.0**.

This was **not** part of the skill question and would have been missed by a skills-only audit. Apache-2.0 carries obligations MIT does not: retain the `NOTICE`, include the license text, and state any modifications made to the licensed files.

## 3. Obligations to satisfy before distributing the image

1. **MIT (upstream + 4 Nous skills + 1 third-party skill).** Retain the copyright notice and license text. The image already copies the upstream tree including `/opt/hermes/LICENSE`, and the per-skill `LICENSE` files travel with their skill directories, so this is satisfied by construction today — but it must not be "optimised" away by a future image-slimming change. **`creative/humanizer`'s separate notice is the one most at risk from that.**
2. **Apache-2.0 (`plugins/security-guidance/`).** Retain `NOTICE` and the accompanying `LICENSE`, and state modifications if Meri ever patches `patterns.py`. Meri does not modify it today.

Neither obligation restricts commercial use, neither is copyleft, and neither requires releasing Meri's own source.

## 4. Scope and limits of this review

- Covers the **bundled skills and the plugin notices** in the pinned image. It is **not** a full dependency-tree audit of the Python and Node package sets — `node_modules` alone carries many third-party licenses (`rolldown`, `prettier`, `tslib` all ship their own notices). A complete SBOM/dependency audit is a separate exercise and is **not** claimed here.
- Reviewed by reading the seeded container filesystem; if a future image changes the seeding behaviour or the pin moves, this review must be re-run.
