# engagement-api Rollback — Runbook

**Micro-session:** 2.13

The exact order matters. Routing is removed **before** anything about the
service itself changes, because the fastest, safest recovery for the current
product is always "stop sending it any traffic," not "fix the new thing."

---

## Immediate routing rollback (first, always)

```bash
export AWS_REGION=... EXPECTED_AWS_ACCOUNT_ID=... HTTPS_LISTENER_ARN=... \
  ENGAGEMENT_TARGET_GROUP_ARN=... MAIN_API_TARGET_GROUP_ARN=... \
  GENERIC_API_RULE_PRIORITY=<discovered>

export CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE=<the exact rule ARN>
bash scripts/engagement-api-alb-rules.sh delete-preview
bash scripts/engagement-api-alb-rules.sh list
```

`delete-preview` re-fetches the rule by ARN and refuses if it has drifted from
the exact expected shape — see
[engagement-api-preview-rule.md](engagement-api-preview-rule.md). If it
refuses, the rule was hand-edited; resolve that before trying again rather
than forcing the deletion.

**Verify:**
- The preview rule is gone.
- The generic `/api/*` rule is byte-identical to before (`list` output).
- The current product is healthy (normal Engagement request succeeds).
- Recall is unaffected.

---

## Service rollback

Only after routing is confirmed removed:

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER_ARN" \
  --service "capiro-<env>-engagement-api" \
  --desired-count 0
```

Use the exact current CLI syntax and identifiers from that environment's
discovery output. **Never scale the main API** as part of this procedure.

---

## Stack rollback (optional, after routing removal)

```bash
cd infra/cdk
pnpm exec cdk destroy Capiro-<env>-EngagementApiService \
  --app "ts-node --prefer-ts-exts bin/engagement-api.ts"
```

Retain the Network and Registry stacks when useful for a faster re-deploy.
**Never destroy a target group while any listener rule still references it**
— confirm the preview rule is gone (step 1) before this step.

ECR and the log group are `RETAIN`; a stack destroy does not delete their
data. Document manual cleanup separately if it is ever actually wanted —
do not delete images or logs as part of an ordinary rollback.

---

## Image rollback (a specific deployment was bad)

- Update the deployment config to the **previous known-good digest**.
- Redeploy the Service stack with that config.
- **Never retag or mutate the old image** — repository immutability is the
  whole point.
- Record both digests (the bad one and the restored one) in the incident
  evidence.

---

## Production emergency order

If this is ever run in production (Gate E, separately authorized, not yet
performed as of this handoff):

```text
1. delete the preview rule
2. verify current UI / main API
3. scale engagement-api to zero
4. investigate
```

**The current product must recover after step 1 alone.** If it does not,
the preview rule was never actually the isolation boundary it was supposed to
be, and that is the incident — not the dark service's internal health.

---

## What rollback never touches

- The generic `/api/*` rule.
- DNS or certificates.
- The frozen historical Compute stack.
- The main API's desired count.
- Aurora.
