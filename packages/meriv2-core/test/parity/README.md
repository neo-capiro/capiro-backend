# MeriV2 live parity harness (SC0.3)

`parity.ts` diffs the legacy in-process path (flag OFF) against the MeriV2
orchestrator path (flag ON) for the same fixed corpus, so we can prove — before
removing any legacy routing-gate condition — that MeriV2 returns equivalent
answers for the same `(user, tenant, client)`.

- **Deterministic fields** (ids, counts, structured data) must be DEEP-EQUAL.
- **Graded fields** (model prose) are compared with a semantic tolerance.

Without `MERIV2_PARITY_LIVE=1` the runner does a synthetic self-check of the diff
mechanics over the real corpus (what CI's unit test covers). The LIVE both-paths
run requires a reachable api + orchestrator + DB + model and a valid Clerk JWT.

## CI (recommended)

`.github/workflows/meriv2-parity.yml` — `workflow_dispatch`, targets **prod**
(`app.capiro.ai`; MeriV2 fullChat is GA fleet-wide). One-time setup:

- Repo **Variables** (Settings → Secrets and variables → Actions → Variables):
  - `PARITY_API_BASE_URL` = `https://app.capiro.ai/api`
  - `PARITY_ORCH_BASE_URL` = `https://app.capiro.ai`
  - `PARITY_WS_BASE_URL` = `https://app.capiro.ai/workspace-api`
- Optional repo **Secrets**: `PARITY_CLIENT_ID`, `PARITY_DRAFT_ID`, `PARITY_BEARER_TOKEN`
  (the token is normally passed as a run input instead — it expires fast).

Trigger:

```bash
gh workflow run meriv2-parity.yml \
  -f bearer_token='<fresh Clerk session JWT>' \
  -f client_id='<real client id>' \
  -f run_workspace_gen=false     # true also runs the MUTATING workspace-gen case (needs PARITY_DRAFT_ID)
```

Expect `in-editor[live]: X/20 parity-identical.`; the workspace-gen line prints
`SKIPPED` when `run_workspace_gen` is false (never silently passed). Non-zero
exit on any deterministic mismatch.

## Local

```bash
MERIV2_PARITY_LIVE=1 \
PARITY_API_BASE_URL=http://localhost:3000/api \
PARITY_ORCH_BASE_URL=http://localhost:4300 \
PARITY_BEARER_TOKEN='<clerk jwt>' \
PARITY_CLIENT_ID='<client id>' \
pnpm --filter @capiro/meriv2-core parity
# add PARITY_WS_BASE_URL + PARITY_DRAFT_ID to also run the mutating workspace-gen case
```

## Cutover gate

Run this green (in-editor case at minimum) before removing each legacy
routing-gate condition (page-write, images, impersonation) in the gold-standard
plan's Wave 2. The nightly cron in the workflow stays commented until a
Clerk-backend token-minting step replaces the paste-in JWT.
