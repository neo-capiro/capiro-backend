# Measurements — Phase 0 harness (local host)

Environment: Windows 11 host (16 logical CPUs), Docker Desktop 4.89 (linux/amd64 engine), worker container limited to `--cpus 1 --memory 2g` (the plan's 1 vCPU / 2 GiB benchmark class), fixture Postgres in Docker, harness API on the host, model `gpt-5.6-luna` via the platform OpenAI endpoint. **These are local observations from a handful of runs, not production latency or cost guarantees.** Raw numbers: `evidence/<run>/measurements.json`, `D*.json`, `worker-starts.json`, `CAPS.json`.

## Startup

| Measure | Observed | Notes |
|---|---|---|
| Base image build (cold, this host) | ≈35 min dependency layers + 208 s final assembly | upstream Dockerfile; pulls uv/node images, builds SQLite, `uv sync`, Playwright chromium |
| Meri layer rebuild | < 10 s | plugins + templates only |
| Worker **cold start** (fresh volume) | **82.1 s** on the very first container start of the image; **14.6–19.1 s** on every later fresh-volume start (Alice 18.3 / 17.5 / 17.6 s, Bob 17.6 / 19.1 / 14.6 s) | to `/health` 200; includes s6 init, first-boot seeding of 58 bundled skills and gateway start. The 82 s outlier is Docker Desktop warming the 3.96 GB image layers; image pull time is not included (image local). |
| Worker **warm start** (existing volume, container replaced) | **13.6 s** (D3c) | no skill seeding on the second boot; see also `D6c.restartMs` |
| Harness API (Nest, real modules, fixture DB) | ≈60–70 s from spawn to listening (tsc-compiled output) | not representative of the deployed API |

## Turn latency (D1, run `2026-09-19T13-41-59`)

Prompt: "Introduce yourself … run `echo MERI-D1-$(date +%s)` … tell me the output" (one native terminal tool call).

| Point | ms from request |
|---|---|
| First SSE frame (`turn_accepted`, user message persisted) | 80 |
| `start` (run admitted to Hermes) | 101 |
| First tool call frame (`terminal`) | 4 106 |
| First text token | 5 888 |
| `done` | 6 170 |
| Terminal tool wall time (Hermes-reported) | 1.119 s |
| Broker `meri_memory_search` (Meri governed recall, fixture DB) | 0.065 s per call |

Per-run wall time across the three D2 turns: 6.1 s, 5.9 s, 3.6 s.

## Tokens (real provider usage, Hermes-reported)

| Run | Input | Output |
|---|---|---|
| D1 (intro + terminal) | 23 306 | 104 |
| D2 (three turns, Alice conversation) | 84 197 total in | 420 total out |
| Manual `PONG` turn (no tools) | 11 543 | 6 |
| All 23 runs kept in one harness API session (phases D1–D5 incl. re-runs; ingestion, skill creation, approvals) | 1 080 917 | 5 051 |

Average ≈ 47 k input tokens per run across the whole phase set (tool-heavy turns such as D4 ingestion — `skill_view`, `tool_search`, `tool_describe`, `meri_fetch_attachment`, `read_file`, `write_file`, `meri_publish_artifact` — dominate). D4 end-to-end: attachment materialised, natively read, summarised and published in **15.6 s** (artifact frame time).

The floor is roughly **11.5 k input tokens per turn** on this build even for a one-word answer: Hermes' system prompt (tool schemas for the `hermes-api-server` toolset incl. the Meri plugin tools, the bundled-skills index, SOUL.md and the Meri instructions). Tool-using turns run 20–25 k input because each tool round-trip resends context. Cost implications: input tokens dominate; prompt caching (Hermes `prompt_caching` config) and toolset trimming (`agent.disabled_toolsets`, fewer bundled skills) are the first levers and are Phase 1 backlog items. Cost in dollars is **not asserted** here: `estimated_cost_usd` stays inside Hermes' `state.db` (`session_model_usage`) and the platform's price sheet was not supplied to the harness (`MERI_HERMES_PRICE_INPUT_PER_M` / `_OUTPUT_PER_M` are accepted when known).

Background-learning usage: recorded by Hermes under `session_model_usage task='background_review'` (~30 k tokens per review per upstream comments); the harness did not capture a review in the short D3d probe — see `checks-report.md` D3d.

## Stop, detach, restart (D6)

| Measure | Run `14-00-58-074Z` (quiet host) | Re-run `14-07-11-015Z` (host busy with tsc + jest) |
|---|---|---|
| Stop request → Meri run terminal (`cancelled`) | **225 ms** | 840 ms |
| Disconnect point (first text frame) | 9.5 s after request | 2.1 s after request (3 frames seen) |
| Detached run: frames replayed from `after=0` | 127 frames / 584 text chars | 97 frames / 474 text chars |
| Worker replacement (container removed and recreated on the same volume) → `/health` 200 | **13.0 s** | 26.5 s |
| Continuation turn on the fresh worker | correct answer (8 facts, "END") | correct answer; Hermes `session_id` bound |

Stop latency is dominated by Hermes' hard interrupt of the running tool (the `terminal` loop) plus one status poll. Restart time doubles under CPU contention on the host, which is a reminder that the plan's warm-capacity decision, not per-turn speed, sets user-visible recovery time.

Token totals across the whole Phase 0 evidence set: first harness API session (26 runs, D1–D6 incl. re-runs) **1 164 029 in / 5 438 out**; D6 re-run session (3 runs) 22 333 in / 164 out.

## Resources (`docker stats`, 1 vCPU / 2 GiB limit)

| Sample | CPU | Memory |
|---|---|---|
| idle after start | 0.67 % | 375 MiB |
| after D1 | 0.37 % | 387 MiB |
| end of phase | 0.66 % | 391 MiB |

After a container replacement on an existing volume (D6c re-run) the worker idles at **218–225 MiB** (the 375–390 MiB figures above include the first-boot skill seeding and the D1–D5 tool sessions of a long-lived container). Memory sits under 400 MiB idle/between turns for one worker with no browser session; CPU is negligible while waiting on the model. A 1 vCPU / 2 GiB class is sufficient for text + terminal + file work; browser automation (Playwright chromium ships in the image) was not exercised and is the reason the plan keeps a larger class in reserve.

## Compute cost inputs

Plan §14 baseline: $0.0494 per worker-hour (1 vCPU / 2 GiB Fargate Linux/x86, us-east-1); ARM64 pricing is lower but the image is not yet built for arm64. Observed worker time per demonstration turn is 4–8 s of wall clock, so the dominant compute cost in production will be **idle/warm time**, not turns — the warm-capacity decision (Phase 1 decision list) drives cost more than per-turn latency. Local image size (3.96 GB) implies a meaningful pull time on cold Fargate tasks that this harness cannot measure.

## What was not measured

- Production network path (ALB, NAT) between the API and workers.
- Browser tasks, delegation (subagents), background review token usage, compression.
- arm64 performance.
