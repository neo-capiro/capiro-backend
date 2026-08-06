# Phase 2 — Engagement API Dark Fargate Deployment

**Status:** Micro-sessions 2.0–2.13 code-complete. 2.14 (independent
validation) pending. 2.15–2.20 (live AWS work) not started — this
environment has no AWS credentials.

**Branch:** `agent/engagement-api-phase-2-dark-fargate`
**Base:** the accepted Phase 1 head `47902517c7dd64a408a87cef57323812407c29c8`

This document is the durable record of what Phase 2 built. For the day-to-day
detail behind each claim, follow the links — this page is deliberately a
summary, not a restatement.

---

## What Phase 2 is

An independently deployable, dark `engagement-api` Fargate service that no
ordinary user traffic can reach. Canonical `/api/engagement/*` traffic and the
Recall webhook stay on the main API until a later phase's explicit cutover
(Phase 10). Nothing in Phase 2 changes the current product.

Full architecture: [phase-2-engagement-api-dark-fargate-executable-plan.md](../../../phase-2-engagement-api-dark-fargate-executable-plan.md)
(external, not committed — see the input lock for its hash).

## What Phase 2 explicitly is not

- Not Outreach V3. No production V3 UI ships. The 62-state
  [prototype contract](../contracts/outreach-v3-prototype-contract-v1.md) and
  [capability matrix](../contracts/outreach-v3-ui-api-capability-matrix-v1.md)
  exist so that later phases (5–9) have a ready-made map, not so Phase 2 can
  implement any of it.
- Not a merge. Phase 10 owns cutover.
- Not a database change.
- Not a change to the frozen historical Compute stack — Phase 2 imports every
  live resource by identifier through an independent, additive CDK app.

---

## Delivered contracts and infrastructure

| Session | What | Evidence |
|---|---|---|
| 2.0 | Input lock: base SHA, Phase 0/1 acceptance, four locked hashes | [phase-2-input-lock.md](phase-2-input-lock.md) |
| 2.1 | Prototype → 62-state deterministic manifest | [contract doc](../contracts/outreach-v3-prototype-contract-v1.md) |
| 2.2 | Every state → one Phase 2 capability + future owner | [matrix doc](../contracts/outreach-v3-ui-api-capability-matrix-v1.md) |
| 2.3 | Fail-closed infra config; read-only discovery | `infra/cdk/lib/engagement-api/engagement-api-config.ts` |
| 2.4 | ECR Registry stack | `infra/cdk/lib/engagement-api/engagement-api-registry-stack.ts` |
| 2.5 | Network stack, empty target group | `infra/cdk/lib/engagement-api/engagement-api-network-stack.ts` |
| 2.6 | Dark Fargate service, shadow posture | `infra/cdk/lib/engagement-api/engagement-api-service-stack.ts` |
| 2.7 | Least-privilege IAM, 9 secret fields | `infra/cdk/lib/engagement-api/engagement-api-iam.ts` |
| 2.8 | Alarms, events, dashboard | [observability contract](../contracts/engagement-api-observability-fields-v1.md) |
| 2.9 | Template safety verifier, 23 negative controls | `scripts/verify-engagement-phase2-template.mjs` |
| 2.10 | Immutable image publication | [image runbook](../runbooks/engagement-api-image-publication.md) |
| 2.11 | Fail-closed ALB preview rule manager | [preview-rule runbook](../runbooks/engagement-api-preview-rule.md) |
| 2.12 | UI-aware preview probe manifest | [acceptance runbook](../runbooks/engagement-api-ui-aware-preview-acceptance.md) |
| 2.13 | CI wiring, deploy/rollback runbooks, this document | — |

**282 assertions** across every spec file, all passing against synthetic
fixtures and fake AWS/docker binaries. `cdk synth` succeeds for all three
stacks. Verify locally with:

```bash
pnpm verify:engagement-phase-2
```

See [the 2.0–2.10 handoff](phase-2-handoff-2.0-to-2.10.md) for the full gate
list and the non-obvious things that will bite the next agent.

---

## Dark posture, in one place

```text
priority 6:
  path        /api/engagement/*
  AND header  X-Capiro-Engagement-Preview: v3
  -> engagement-api target group (empty until Gate C)

generic /api/*:                      unchanged -> main API
/webhooks/recall:                    unchanged -> main API
current production web:              sends no preview header
engagement-api task:
  ENGAGEMENT_PROCESS_MODE=shadow
  ENGAGEMENT_BACKGROUND_OWNER=disabled
  ENGAGEMENT_EXTERNAL_ACTIONS=disabled
  ENGAGEMENT_CALLBACKS_ENABLED=false
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false
```

The header is routing metadata, not authorization — every standard auth,
tenant, role, and ownership check still runs downstream.

---

## Findings worth carrying past Phase 2

1. **A GET route generates.** `GET /api/engagement/outreach/ai-templates/:id/preview`
   carries the `outreach_generate` runtime action. It is classified as a
   shadow-denial probe, never a safe read — the capability verifier rejects
   any attempt to classify a route carrying runtime-action metadata as safe.
2. **Phase 3 cannot claim Directory parity through preview.** The Directory
   is not in the Engagement route manifest; ten target/profile states have no
   current route and are recorded as Phase 7 gaps.
3. **The repo-wide `turbo run typecheck` is red on `main`**, for four
   pre-existing `defense-budget` rootDir violations unrelated to this work —
   reproduced on a clean `origin/main` checkout. CI's existing `verify` job
   already runs this unconditionally and is therefore presently failing on
   `main` independent of Phase 2. The new `engagement-phase-2` CI job is a
   **separate job**, not a step appended after that failing one, specifically
   so this gate reports its own real status rather than never executing.
4. **Two environment-specific bugs, both fixed, same root cause class:**
   process substitution (`<(...)`) and `mktemp -d`'s POSIX paths do not
   survive the Git-Bash-to-native-Windows-node boundary. Every Phase 2 script
   now writes real temp files instead.

---

## What remains

- **2.14** — independent code and architecture validation. Exit
  `APPROVED_FOR_DEV_DEPLOYMENT` or `NOT_APPROVED`.
- **2.15–2.20** — live AWS work. Requires credentials this environment does
  not have, and Gates B/C/D each require separate, explicit human
  authorization naming the exact environment/account/region/stack.
- **Two open items, owner's call:** promoting the 2.0 input-lock verifier
  from `.artifacts/` into `scripts/`, and the mislabeled
  `clerkAuthentication` field in the Phase 1 evidence bundle (fixing it
  invalidates that accepted bundle and needs a full re-run).
