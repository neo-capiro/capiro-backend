# Phase 0 harness run 2026-09-19T13-58-39-857Z

image: meri-hermes-worker:v2026.9.14-meri  model: gpt-5.6-luna (custom @ https://api.openai.com/v1)

| id | title | status |
|---|---|---|
| CAPS | Pinned build capability inspection over /v1/capabilities, /v1/toolsets, /v1/skills | passed |
| D5a | Clarification via broker adapter: durable pending interaction, survives reconnect replay, resolved by next message | passed |
| D5b | Native approval over /v1/runs: guarded command surfaces approval.request; Meri denies; command does not run | failed |
| D5c | Native approval: approve_once resumes the live process and the command runs | failed |
| D5d | Cancel while a native approval is pending → terminal cancelled, no success publication | failed |

Cold start: null ms. Runs: 18. Tokens in/out: 918482/4749.