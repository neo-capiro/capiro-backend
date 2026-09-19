# Phase 0 harness run 2026-09-19T13-53-10-659Z

image: meri-hermes-worker:v2026.9.14-meri  model: gpt-5.6-luna (custom @ https://api.openai.com/v1)

| id | title | status |
|---|---|---|
| CAPS | Pinned build capability inspection over /v1/capabilities, /v1/toolsets, /v1/skills | passed |
| D3a | SOUL.md personality applied in the worker (native) | passed |
| D3b | Explicit native skill creation via skill_manage persists SKILL.md in the scope home | passed |
| D3c | Worker replacement preserves SOUL.md + skills; skill reused in a later task | passed |
| D3d | Automatic learning probe (background review after an unrequested multi-step task) | observed |
| D4 | File ingestion (native read_file over a Meri attachment) → artifact publish → authorized retrieval | failed |

Cold start: 17527 ms. Runs: 12. Tokens in/out: 603336/3574.