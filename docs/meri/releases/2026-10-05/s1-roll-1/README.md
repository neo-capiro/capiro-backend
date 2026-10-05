# Stage 1 roll 1 (2026-10-05)

Source: main `c805ed15ce355debb7aa15c82ea8fe0d4ff2b070`. Orchestrator first, then API. Code only.

| Service | Image | Build |
| --- | --- | --- |
| meriv2-orchestrator | `sha256:4ee1bfcdd1d2…` | `fffd0a9e-a881-435b-ae4d-087947b169db` |
| api | `sha256:9f71e4869ce6…` | `47d1586b-88cc-41b4-af01-70f7b39061ac` |

Changes: #2001 (Case 45 attachment coverage), #2003 (two-key V3 kill switch, "Meri is unavailable" refusal), #2005 (budget and bill citations), #2006 (budget "how did" is not a vote), #2007 (OpenAI Retry-After). #2004 is CDK only.

Builds use the lean Stage 1 launcher (`phase-*.sh` here): native ARM64 CodeBuild, image import smoke test, push by SHA, digest readback. No capture-harness assertions (program plan §9).

Pending migrations already in the API image and NOT applied by this roll: `20261005160000_krisp_notetaker` (from #2000) and `20281007020000_clio_attachments_xlsx_kind` (#1996). They are applied separately with Neo's OK.

Served baseline before the roll: `served-baseline.json` (api:555 from `be4d886ff`, orchestrator:139 from `a442cafb3`, web-vnext:392). Both are ancestors of the candidate.
