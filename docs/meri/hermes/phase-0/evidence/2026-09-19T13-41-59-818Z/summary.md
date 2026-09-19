# Phase 0 harness run 2026-09-19T13-41-59-818Z

image: meri-hermes-worker:v2026.9.14-meri  model: gpt-5.6-luna (custom @ https://api.openai.com/v1)

| id | title | status |
|---|---|---|
| CAPS | Pinned build capability inspection over /v1/capabilities, /v1/toolsets, /v1/skills | passed |
| D1 | Real Hermes turn: streamed text, native terminal tool, completion, usage | passed |
| D2a | Authorized broker read through Meri governed memory (firm fact visible, other user private fact absent) | passed |
| D2b | Governed memory write path: proposal lands as a real memory_candidate (never a raw write) | passed |
| D2c | Ethical wall + private scope: Bob cannot recall the walled client fact or Alice private fact | failed |
| ISO1 | Cross-user: Bob cannot read Alice run (guessed id → 404) | passed |
| ISO2 | Cross-tenant: outside tenant is not routed to Hermes (gate false, stream refused) | passed |
| ISO3 | Spoof: asserting the pilot tenant with a non-member identity is refused; body tenant fields are ignored | passed |
| ISO4 | Broker credential boundary: tampered token 401, other-user token on Alice run 403, unknown run 404, missing token 401, finished run 409 | passed |
| ISO5 | Feature flag off: pilot tenant immediately leaves Hermes (gate false, stream not routed, control surface 404) | passed |

Cold start: null ms. Runs: 3. Tokens in/out: 84197/420.