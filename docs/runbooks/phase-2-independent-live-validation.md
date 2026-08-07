# Phase 2 — Independent Live Validation

**Purpose:** closes the one gap Phase 2's own input-lock doc names honestly:
*"No independent reviewer has validated the live deploy"* — 2.14 validated
code-complete, before any AWS credential existed in this program. This runbook
is that missing review, for the actual `capiro-dev` state.

**Hand this to a different agent or model than the one that implemented and
deployed Phase 2.** Self-review defeats the purpose — an agent re-checking its
own work will tend to confirm what it already believes.

**Every command below is read-only.** Nothing here creates, deletes, or
modifies any AWS resource, deploys anything, or scales anything. If a command
you're asked to run isn't read-only, stop and ask before running it.

**Environment:** `AWS_PROFILE=capiro-dev` (account `967807252336`, `us-east-1`).
No `[default]` profile exists on this machine — if credentials aren't found,
check `AWS_PROFILE` is set before assuming they're missing.

**Repository:** `neo-capiro/capirov2`, worktree `C:\Users\neoma\Downloads\capiro-eng-p2`.

---

## Important context before you start

**The "dark preview" rule lives on the live production ALB, not a separate dev
ALB.** `capiro-prod-alb` (account `967807252336`) serves real production
traffic today. The engagement-api preview rule is priority 6 on that same
listener. This is by design — the plan requires reusing the existing live
routing rather than standing up parallel infrastructure — but it means
"ordinary traffic unaffected" in section 3 below is not a formality. If that
check fails, real users are affected, not a sandbox.

---

## 1. Service and infrastructure state

```bash
export AWS_PROFILE=capiro-dev

# ECS service: expect ACTIVE, running == desired == 1
aws ecs describe-services --region us-east-1 \
  --cluster capiro-dev --services capiro-dev-engagement-api \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition,deployments:length(deployments)}'

# Target health: expect "healthy"
TG_ARN=$(aws elbv2 describe-target-groups --region us-east-1 \
  --names capiro-dev-engagement-api --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --region us-east-1 --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[].TargetHealth.State' --output text

# All 8 alarms: expect every one OK
aws cloudwatch describe-alarms --region us-east-1 \
  --alarm-name-prefix "capiro-dev-engagement-api" \
  --query 'MetricAlarms[].{name:AlarmName,state:StateValue}' --output table
```

Expect exactly these 8 alarm names, all `OK`: `Cpu`, `DatabaseConnections`,
`FatalBootstrap`, `HealthyHosts`, `InvalidShadowPosture`, `LatencyP95`,
`Memory`, `Target5xx`. A missing alarm is itself a finding — it means an
expected safety net does not exist.

---

## 2. Shadow-mode posture — the containment claim

The whole safety argument for a "dark" service rests on these five task
definition environment variables. Verify them directly; do not trust the
handoff doc's transcription.

```bash
TASK_DEF=$(aws ecs describe-services --region us-east-1 \
  --cluster capiro-dev --services capiro-dev-engagement-api \
  --query 'services[0].taskDefinition' --output text)

aws ecs describe-task-definition --region us-east-1 --task-definition "$TASK_DEF" \
  --query 'taskDefinition.containerDefinitions[0].environment' --output json \
  | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const env = Object.fromEntries(JSON.parse(d).map(e=>[e.name,e.value]));
      const expect = {
        ENGAGEMENT_PROCESS_MODE: 'shadow',
        ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
        ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
        ENGAGEMENT_CALLBACKS_ENABLED: 'false',
        ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
      };
      let ok = true;
      for (const [k, want] of Object.entries(expect)) {
        const got = env[k];
        const pass = got === want;
        ok = ok && pass;
        console.log((pass ? 'PASS' : 'FAIL') + '  ' + k + ' = ' + got + '  (expect ' + want + ')');
      }
      console.log('RELEASE_SHA present: ' + (env.RELEASE_SHA ? 'yes (' + env.RELEASE_SHA + ')' : 'NO'));
      process.exit(ok ? 0 : 1);
    });
  "
```

If any of these five is not what's expected, the "dark" claim is false and
this is a P0 finding — it means the service could take a real external action
or own real background work while still being called "shadow."

---

## 3. Ordinary traffic is provably unaffected

This is the one that matters most given section "Important context" above.
Run both requests; the second must NOT reach engagement-api.

```bash
# Ordinary request, no preview header — must NOT carry X-Capiro-Service: engagement-api
curl -sS -D - -o /dev/null https://app.capiro.ai/api/health

# Preview request — must carry X-Capiro-Service: engagement-api and 401
# (401 is correct: auth is still enforced, this only proves routing, not a bypass)
curl -sS -D - -o /dev/null \
  -H "X-Capiro-Engagement-Preview: v3" \
  https://app.capiro.ai/api/engagement/capabilities
```

Cross-check the rule itself, independent of any doc's claim about it:

```bash
LISTENER_ARN=arn:aws:elasticloadbalancing:us-east-1:967807252336:listener/app/capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440

aws elbv2 describe-rules --region us-east-1 --listener-arn "$LISTENER_ARN" --output json \
  | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const rules = JSON.parse(d).Rules;
      const p6 = rules.find(r => r.Priority === '6');
      const p10 = rules.find(r => r.Priority === '10');
      console.log('priority 6 conditions:', JSON.stringify(p6?.Conditions));
      console.log('priority 6 target:    ', p6?.Actions?.[0]?.TargetGroupArn);
      console.log('priority 10 target:   ', p10?.Actions?.[0]?.TargetGroupArn);
      const needsHeader = p6?.Conditions?.some(c => c.Field === 'http-header' && c.HttpHeaderConfig?.HttpHeaderName === 'X-Capiro-Engagement-Preview');
      const needsPath = p6?.Conditions?.some(c => c.Field === 'path-pattern' && c.Values?.includes('/api/engagement/*'));
      const routesToEngagementApi = p6?.Actions?.[0]?.TargetGroupArn?.includes('engagement-api');
      const p10Untouched = p10?.Actions?.[0]?.TargetGroupArn?.includes('capiro-prod-api-tg');
      console.log('');
      console.log((needsHeader && needsPath ? 'PASS' : 'FAIL') + '  priority 6 requires BOTH header AND path (not either alone)');
      console.log((routesToEngagementApi ? 'PASS' : 'FAIL') + '  priority 6 targets the engagement-api target group');
      console.log((p10Untouched ? 'PASS' : 'FAIL') + '  priority 10 (generic /api/*) still targets the original prod API target group');
    });
  "
```

If priority 6 matches on the header **or** the path alone (not both), ordinary
traffic without the header could still be misrouted — that is a P0.

---

## 4. Image provenance and scan status

```bash
RELEASE_SHA=17cdcb5cadaa91466b7708ad4399ffbea33a63fe   # from the input-lock doc — verify it's still what's deployed via section 2 above

aws ecr describe-images --region us-east-1 \
  --repository-name capiro/dev/engagement-api \
  --image-ids imageTag="$RELEASE_SHA" \
  --query 'imageDetails[0].{digest:imageDigest,mediaType:imageManifestMediaType,scanStatus:imageScanStatus.status,pushedAt:imagePushedAt}'
```

`mediaType` must be a single-manifest type
(`application/vnd.docker.distribution.manifest.v2+json` or an OCI manifest —
**not** an index type). An index means ECR silently scanned the wrong child
manifest and `scanStatus` is meaningless (documented Phase 2 finding #2 —
confirm the fix held, don't just trust that it did).

```bash
aws ecr describe-image-scan-findings --region us-east-1 \
  --repository-name capiro/dev/engagement-api \
  --image-id imageTag="$RELEASE_SHA" \
  --query 'imageScanFindings.findingSeverityCounts'
```

Cross-check any Critical/High findings against the exact accepted CVE ID list
in `scripts/engagement-api-image.sh`'s `ACCEPTED_FINDINGS` — a finding on any
package other than the reviewed `perl-base` CVEs, or a *different* CVE ID on
`perl-base`, must still fail. If you find one that isn't in that list, that's
an open finding, not something to wave through because "the CVE gate has
exceptions already."

---

## 5. KMS key claims (the two documented data-integrity fixes)

Verify directly rather than trusting the handoff's transcription of the ARNs:

```bash
aws secretsmanager describe-secret --region us-east-1 \
  --secret-id /capiro/dev/aurora/app --query 'KmsKeyId' --output text

aws secretsmanager describe-secret --region us-east-1 \
  --secret-id /capiro/dev/aurora/master --query 'KmsKeyId' --output text

# Both above should match: arn:...:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e
# (or its alias) — NOT arn:...:key/ffcfa6a7-dcf9-404b-924e-fff133b43450 (that's
# the general-purpose key, used only for ECR).
```

```bash
# The Service stack must own its log group's key directly — kmsKeyArns.logs
# should no longer appear anywhere in the live config or CDK output.
aws logs describe-log-groups --region us-east-1 \
  --log-group-name-prefix /capiro/dev/engagement-api \
  --query 'logGroups[0].kmsKeyId'
```

---

## 6. DB connection budget

```bash
aws cloudwatch describe-alarms --region us-east-1 \
  --alarm-names capiro-dev-engagement-api-DatabaseConnections \
  --query 'MetricAlarms[0].Threshold'
```

Documented fix: threshold should be **85**, not 90 — 90 violated the stack's
own safe-ceiling formula (`floor(databaseMaxConnections * 0.8)` = 89 at
`databaseMaxConnections: 112`). If it's back to 90 or anything above 89,
that's a regression, not a rounding difference.

---

## 7. No unauthorized scope creep

```bash
cd /path/to/your/checkout/of/capirov2   # or the shared worktree, read-only

git log --oneline agent/engagement-api-phase-2-dark-fargate -1
git diff --stat 47902517c7dd64a408a87cef57323812407c29c8..3841a5ee58e011be7fb4fb6008adfccf081976d9 -- infra/cdk/lib/compute-stack.ts infra/cdk/bin/capiro.ts infra/cdk/lib/config.ts

# expect: no output — the frozen historical Compute stack and root CDK app
# must be untouched by Phase 2
```

```bash
git diff --name-only 47902517c7dd64a408a87cef57323812407c29c8..3841a5ee58e011be7fb4fb6008adfccf081976d9 -- apps/web/
git diff --name-only 47902517c7dd64a408a87cef57323812407c29c8..3841a5ee58e011be7fb4fb6008adfccf081976d9 -- apps/api/prisma/migrations/

# expect: no output for either — no web change, no migration in Phase 2
```

```bash
git log --oneline main -1
git branch --contains 3841a5ee58e011be7fb4fb6008adfccf081976d9 | grep -x '* main'

# expect: the second command prints nothing — Phase 2 is NOT merged to main.
# Per both plans, merge is deliberately Phase 10. Finding "Phase 2 is merged"
# here would itself be a scope violation, not good news.
```

---

## 8. Verdict

Report one of:

```
PHASE2_LIVE_INDEPENDENTLY_APPROVED
or
PHASE2_LIVE_REJECTED  (list every failing check by section number)
```

Approval requires every check in sections 1–7 to pass as specified — not "close
enough" on the shadow-mode env vars, not "probably fine" on the ALB rule
matching both conditions. This is exactly the kind of review Phase 3's own
3.16 will need for itself; treat it as the template.

---

## Approval record

**Verdict: `PHASE2_LIVE_INDEPENDENTLY_APPROVED`** — 2026-08-07, by an
independent agent (not the agent that implemented or deployed Phase 2).
Every check in sections 1–7 passed as specified. Key evidence:

- Service `ACTIVE`, 1/1, target healthy, all 8 alarms `OK`.
- All five shadow-mode env vars exact match; `RELEASE_SHA` present and
  matches the deployed image tag/digest.
- Priority 6 confirmed to require **both** the header and the path (AND, not
  OR) — verified live against traffic, not just the rule's JSON: an ordinary
  `GET /api/health` got no `X-Capiro-Service` header, and the same path with
  the preview header got `X-Capiro-Service: engagement-api` plus a `401`
  (auth still enforced). Priority 10 unchanged.
- Image digest `sha256:a2ab6d01…` is a single manifest
  (`application/vnd.oci.image.manifest.v1+json`), not an index — the OCI-index
  scan-blindness fix held. 8 Critical/High findings, all exact-ID matches in
  `ACCEPTED_FINDINGS`, no new package or CVE ID.
- Aurora master/app secrets both keyed by the dedicated `efe8a18d-…` CMK, not
  the general-purpose key. Log group keyed by its own dedicated
  `a03eb9a4-…` key, not `kmsKeyArns.logs` (removed from the config contract)
  and not the general-purpose key either.
- `DatabaseConnections` alarm threshold is `85`, not the pre-fix `90`.
- Zero diff on the frozen Compute stack / root CDK app / config, zero web
  diff, zero migration diff, all within Phase 2's own `47902517..3841a5ee`
  range. Confirmed **not** merged to `main` — correct, merge is Phase 10.

**One non-blocking runbook defect found and fixed as a result of this
review:** §3 originally instructed `https://api.capiro.ai`, which does not
resolve (`NXDOMAIN` locally and against `8.8.8.8`, confirmed independently).
The correct front door on the same ALB is `app.capiro.ai`. Corrected above.
This was a runbook-authoring error, not a finding about the deployment
itself — the reviewer used the working hostname and the deployment behaved
correctly.

This closes the gap named in `docs/plans/engagement-api/phase-3-input-lock.md`
§1: Phase 2's live deploy now has an independent live-validation result, not
only 2.14's pre-AWS code-complete validation.
