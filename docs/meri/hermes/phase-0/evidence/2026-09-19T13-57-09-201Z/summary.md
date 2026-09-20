# Phase 0 harness run 2026-09-19T13-57-09-201Z

image: meri-hermes-worker:v2026.9.14-meri  model: gpt-5.6-luna (custom @ https://api.openai.com/v1)

| id | title | status |
|---|---|---|
| CAPS | Pinned build capability inspection over /v1/capabilities, /v1/toolsets, /v1/skills | passed |
| D4 | File ingestion (native read_file over a Meri attachment) → artifact publish → authorized retrieval | passed |

Cold start: 17578 ms. Runs: 13. Tokens in/out: 734627/4238.