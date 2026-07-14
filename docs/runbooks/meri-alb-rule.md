# Runbook — MeriV2 `/meri-api/*` prod ALB rule

## What this is

The MeriV2 orchestrator is reached in prod via a listener rule on the
**hand-managed** `capiro-prod-alb`. That ALB is NOT in CloudFormation — its rules
are created out-of-band. The CDK `ComputeStack` DOES declare an equivalent
`MeriApi` rule, but it attaches to a **different, deleted phantom ALB** (the
`Capiro-dev-Compute` stack is wedged in `UPDATE_ROLLBACK_FAILED`), so the CDK rule
is dead code against prod. **`cdk deploy` must never own these rules.**

## Live state (verified 2026-07-14 via `aws elbv2 describe-rules`)

| Priority | Condition | Target group |
|---|---|---|
| 8 | host `onboarding.capiro.ai` | onboard-api |
| 9 | path `/onboard-api/*` | onboard-api |
| 10 | path `/api/*` | `capiro-prod-api-tg` |
| 12 | path `/workspace-api/*` | `capiro-prod-workspace-tg` |
| **13** | **path `/meri-api/*`** | **`capiro-prod-meriv2-orch-tg`** |
| 14 | path `/intel-api/*` | `capiro-dev-intelapi-albtg` |
| 15 | path `/webhooks/*` | `capiro-prod-api-tg` |
| 20 | host `capiro.ai` | marketing |
| default | — | web |

Notes:
- The `/meri-api/*` rule is at **priority 13** (NOT 15 — several plan docs said 15;
  that reflected the CDK phantom-ALB layout, not live prod). `/webhooks/*` owns 15.
- The target group is **`capiro-prod-meriv2-orch-tg`** (26 chars). The CDK comment's
  `capiro-prod-meriv2-orchestrator-tg` (34 chars) is impossible under AWS's 32-char
  TG-name cap and was never a real name.
- Free priorities as of the snapshot: 11, 16–19.

## Operations

```bash
# Inspect all rules (always do this before any change)
scripts/meri-alb-rules.sh --list

# DR / re-create the rule (it already exists today — this is for rebuild only)
scripts/meri-alb-rules.sh --create <capiro-prod-meriv2-orch-tg ARN>

# Remove it (guarded: refuses unless the target is a meriv2 orchestrator TG)
scripts/meri-alb-rules.sh --delete
```

`PATH_PRIORITY` / `PATH_PATTERN` / `ALB_NAME` / `REGION` are env-overridable. The
`--create` path fails loudly on a priority collision and never clobbers an
existing rule; `--delete` only fires when the rule targets a `*meriv2*` TG.

## Post-change verification

```bash
curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/meri-api/health   # 200
curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/meri-api/tools    # 401 (no JWT)
# re-assert unrelated routes unchanged:
scripts/meri-alb-rules.sh --list   # diff against the table above
```
