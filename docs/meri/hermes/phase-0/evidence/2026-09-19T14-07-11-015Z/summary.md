# Phase 0 harness run 2026-09-19T14-07-11-015Z

image: meri-hermes-worker:v2026.9.14-meri  model: gpt-5.6-luna (custom @ https://api.openai.com/v1)

| id | title | status |
|---|---|---|
| CAPS | Pinned build capability inspection over /v1/capabilities, /v1/toolsets, /v1/skills | passed |
| D6a | Explicit Stop cancels the Hermes run and yields an accurate terminal state | passed |
| D6b | Browser disconnect detaches (run continues), assistant message persisted, reconnect replays events from cursor | passed |
| D6c | Fresh worker start: native session history persists in the scope home; new turn continues the same Hermes session | passed |

Cold start: null ms. Runs: 3. Tokens in/out: 22333/164.