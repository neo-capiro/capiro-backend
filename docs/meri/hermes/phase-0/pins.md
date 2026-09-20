# Phase 0 pins — Hermes build, images and repository baseline

Prepared September 19, 2026. All values below were verified in this session; nothing floats.

## Repository baseline

| Item | Value |
|---|---|
| Repository | `neo-capiro/capirov2` (local `C:/dev/main/git`) |
| Baseline commit inspected by the plan | `19a1834ac` (`fix(legiwatch): resolve axios generic mismatch in ReportWorkspace after dependency bump`) |
| Phase 0 branch / worktree | `feat/meri-hermes-phase-0` at `C:/dev/main/meri-hermes-phase0-worktree`, created from `19a1834ac` |
| Findings rechecked against | the same commit; every code anchor in this folder was read from this checkout |

## Hermes Agent (upstream)

| Item | Value |
|---|---|
| Project | NousResearch/hermes-agent — https://github.com/NousResearch/hermes-agent |
| Pinned tag | `v2026.9.14` |
| Tag object SHA (annotated tag) | `7a963716b81be13ba513d4f127633b7da493aff2` |
| Package version (`pyproject.toml`) | `0.21.3` |
| Source tarball | `https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.9.14.tar.gz` |
| Tarball SHA-256 | `47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834` |
| Python requirement | `>=3.11,<3.14` (upstream image ships Python 3.11 via uv) |
| Dependency policy | every direct dependency exact-pinned upstream (`==X.Y.Z`), resolved through `uv.lock --frozen` inside the image build |
| License | MIT (`LICENSE` in the tarball; `license = "MIT"` in `pyproject.toml`) |
| Upstream `main` at pin time | `7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8` (not used; recorded to show the tag is behind main) |
| Newest tags seen | `v2026.9.7`, `v2026.9.11`, `v2026.9.14` (pinned = newest at 2026-09-19) |

Distribution obligations: MIT requires retaining the copyright notice and license text in copies of the software. The base image copies the upstream tree (including `LICENSE`) into `/opt/hermes`; the Meri layer adds Capiro-owned plugins and templates and does not modify upstream files. No other obligations apply. Hermes bundles 58 upstream skills into `HERMES_HOME/skills` at first boot (seen in the container log: `Done: 58 new … 58 total bundled`); their individual licenses were not audited in Phase 0 and are listed as a Phase 1 review item.

## Container images (local, linux/amd64)

| Image | Content | Image id | Size |
|---|---|---|---|
| `meri-hermes-worker:v2026.9.14` (alias `:7a963716`) | Upstream Dockerfile built from the verified tarball (Debian 13.4, pinned SQLite 3.53.4 with FTS5, s6-overlay 3.2.3.0, Node 26, uv 0.11.6, Playwright chromium headless shell, `uv sync --frozen --extra all --extra messaging --extra otlp --extra anthropic --extra bedrock --extra azure-identity --extra hindsight --extra matrix --extra google-chat`) | `sha256:61871fe53fe912551a758a86f1b142110c1714020069aa9deff6571df135c053` | 3.96 GB |
| `meri-hermes-worker:v2026.9.14-meri` | Base + `docker/hermes-worker/` layer: `entrypoint.sh`, `config.template.yaml`, `SOUL.template.md`, plugins `meri_memory` + `meri_tools` | `sha256:ab2db508544fb499809bfa7ea0ea573782c79ca1e84455dc9339899ef0e76c90` (local image id of the final layer, built 2026-09-19 13:56 UTC after the plugin `**kwargs` and persona-render fixes; earlier layer ids `c839f1b4…` and `61871fe5…`-based interim builds appear in early evidence folders; a registry digest exists only after push) | 3.96 GB |

Build recipe: `docker/hermes-worker/build-base.sh` (downloads the tarball, verifies the SHA-256 above, builds both images). Cold base build on this host: 208 s of final image assembly after roughly 35 minutes of dependency layers (see `scratch` build log summary in `measurements.md`).

Architecture note: production Fargate tasks in this account are **ARM64**. The Phase 0 images are `linux/amd64` for the local harness only. An arm64 build needs a docker-container buildx builder (`PLATFORM=linux/arm64 ./docker/hermes-worker/build-base.sh`) and has **not** been produced or tested — Phase 1 ticket #3.

**ARM64 image BUILT AND PUSHED (2026-09-19) — ticket #3 image work closed.**

| Item | Value |
|---|---|
| Repository | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meri-hermes-worker` |
| Base image tag | `base-v2026.9.14-arm64`, digest `sha256:ae694fa22b874ab030e56888d24c5a787642c4700102ec96bf9c5b9bdeccae2e` (949 MB) |
| Worker image tag | `v2026.9.14-meri-arm64`, index digest `sha256:62ad9aef23f45e67d933a8016c456dea711dc42328727e43ad263fc2251a16ca` |
| **Digest to pin in task definitions** | **`sha256:51b41a3b8002bb7524f71be303ebefef2bfeb3d7f0d56d6fc2b480a0181c454f`** — the `linux/arm64` platform manifest inside that index |
| Verified | `docker buildx imagetools inspect` reports `Platform: linux/arm64`; the amd64 harness images are untouched (`meri-hermes-worker:v2026.9.14-meri` still reports `amd64`) |

Pin the **platform manifest**, not the index: the index also carries a provenance attestation manifest (`unknown/unknown`), and ECS Fargate can reject an index shaped that way. The CI workflow sets `provenance: false` to avoid producing one at all; `build-base.sh` does not.

**Superseded — original ticket #3 status (2026-09-19):** the `capiro-arm` docker-container buildx builder already exists on this host and reports healthy with native `linux/arm64` in its platform list (`docker buildx ls`) — not just QEMU-emulated under the default driver, which is the documented failure mode (see the arm64-build-requirements memory note). `build-base.sh` already supports `PLATFORM=linux/arm64` unchanged; no code or config work remains for this ticket. What's blocking is purely host resources: available physical memory measured at both **1,010 MB and 1,827 MB** at different points in this session, matching (at the low point, exactly) the free-RAM level that caused a documented transient build failure on this same host previously. The real build was deliberately **not** attempted this session for that reason — it is a ~45-minute, resource-intensive, largely unattended operation and this host's headroom is too close to the known failure threshold to run it as background/autonomous work. Recommended before attempting it: close other memory-heavy processes, run it interactively (not backgrounded) so a transient failure is caught early rather than after 35 minutes of dependency-layer build time, and re-check `docker buildx ls` shows `capiro-arm` still healthy immediately before starting.

## Runtime surfaces verified against the pinned build

Read directly from the source tree (`gateway/platforms/api_server.py`, `api_server_runs.py`) and from a running container (`GET /v1/capabilities`, version `0.21.3`):

- `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (SSE), `POST /v1/runs/{id}/stop`, `POST /v1/runs/{id}/approval`, `POST /v1/runs/{id}/steer`
- `Idempotency-Key` (durable, 86 400 s retention), `X-Hermes-Session-Id`, `X-Hermes-Session-Key`
- `/api/sessions` (list/create/read/update/delete/messages/fork/chat/chat-stream/model)
- `/v1/capabilities`, `/v1/toolsets`, `/v1/skills` (**broken on this build**: `TypeError: _find_all_skills() got an unexpected keyword argument 'include_editorial'`), `/health`, `/health/detailed`
- `/api/jobs*`, `/api/cron/fire` present; `jobs_admin: false` in the capability flags
- `/v1/artifacts/upload|download` exist but are scoped to browser-extension control principals, not general file ingestion (`gateway/browser_control_artifacts.py`)

Wire events observed on `/v1/runs/{id}/events`: `message.delta`, `tool.started`, `tool.completed`, `reasoning.available` (dropped by Meri), `subagent.start`, `subagent.complete`, `approval.request`, `approval.responded`, `run.steered`, `run.stopping`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`.

## Local harness dependencies

| Component | Version |
|---|---|
| Docker Desktop | 4.89.0 (engine 29.7.2, linux/amd64) |
| Node | v24.19.0, pnpm 9.12.0, tsx 4.23.13 |
| Postgres (fixture) | `pgvector/pgvector:pg16` via `docker-compose.yml`, 407 Prisma migrations applied |
| Hermes install already on this host (not used) | `Hermes Agent v0.20.0 (2026.8.3)` at `%LOCALAPPDATA%\hermes` — older than the pin; the harness only talks to the container |
