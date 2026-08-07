# engagement-api Preview Rule — Runbook

**Micro-session:** 2.11 · **Script:** `scripts/engagement-api-alb-rules.sh`
**Spec:** `scripts/engagement-api-alb-rules.spec.mjs` (29 assertions)

The live ALB is hand-managed — its rules are **not** in CloudFormation, the
same posture as `scripts/meri-alb-rules.sh` and `scripts/onboard-alb-rules.sh`.
This script differs from those precedents in one respect: it is fail-closed by
construction. It refuses on any ambiguity rather than picking the "obviously
intended" resource, and create and delete each require a distinct, exact
confirmation token.

**The preview header is routing metadata, not authorization.** Every standard
auth, tenant, role, and ownership check still runs downstream. The header only
decides which service sees the request.

---

## Expected layout

```text
priority 6:
  path        /api/engagement/*
  AND header  X-Capiro-Engagement-Preview: v3
  -> forward 100% to the engagement-api target group

generic /api/*:
  unchanged (currently priority 10 on capiro-prod-alb)
  -> main API target group

/webhooks/recall:
  unchanged
  -> main API target group
```

Do not treat priority 5 or 7 as active Phase 2 rules — those are unrelated
capacity, not this rule shifted by one.

---

## Required environment

```bash
export AWS_REGION=us-east-1
export EXPECTED_AWS_ACCOUNT_ID=<account>
export HTTPS_LISTENER_ARN=<from discovery>
export ENGAGEMENT_TARGET_GROUP_ARN=<from the Network stack output>
export MAIN_API_TARGET_GROUP_ARN=<from discovery>
export GENERIC_API_RULE_PRIORITY=<the DISCOVERED live value — do not assume 10>
```

`PREVIEW_RULE_PRIORITY` (6), `PREVIEW_HEADER_NAME`
(`X-Capiro-Engagement-Preview`) and `PREVIEW_HEADER_VALUE` (`v3`) default to
the Phase 2 contract and should not normally be overridden.

---

## Commands

### `list` — read-only

```bash
scripts/engagement-api-alb-rules.sh list
```

Describes every rule on the listener, sorted by priority. Makes no mutating
call.

### `verify-baseline` — read-only, run before every create

```bash
scripts/engagement-api-alb-rules.sh verify-baseline
```

Runs the twelve pre-create checks from the full Phase 2 plan §14:

1. Caller identity verified.
2–3. Every listener rule described and saved.
4. Preview priority 6 is unoccupied.
5. Generic API rule at the discovered priority exists.
6. Generic API rule includes `/api/*`.
7. Generic API rule forwards **only** to the main API target group.
8. No rule already matches `/api/engagement/*`.
9. No rule routes `/webhooks/recall` to `engagement-api`.
10–11. `ENGAGEMENT_TARGET_GROUP_ARN` resolves to a target group named
   `*engagement-api*` on port 4500.
12. **Current web/main API health is not checked by this script.** Run the
    live acceptance harness (2.12/2.18) immediately before mutating.

Exits 2 and writes `.artifacts/engagement-phase2/<region>/verify-baseline.json`
if anything fails.

### `create-preview` — mutating, Gate D

```bash
export CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE="${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:6"
scripts/engagement-api-alb-rules.sh create-preview
```

The token must name the exact account, region, and priority about to change —
copy-pasting a token from a different environment will not match. Before
creating, the script independently re-verifies (it does not merely trust a
prior `verify-baseline` run):

- the target group is engagement-api on port 4500,
- priority 6 is still free,
- the generic rule has not drifted,
- no `/api/engagement/*` rule exists,
- no rule already routes Recall to `engagement-api`.

Creates exactly:

```json
[
  { "Field": "path-pattern", "PathPatternConfig": { "Values": ["/api/engagement/*"] } },
  { "Field": "http-header", "HttpHeaderConfig": { "HttpHeaderName": "X-Capiro-Engagement-Preview", "Values": ["v3"] } }
]
```

forwarding 100% to `ENGAGEMENT_TARGET_GROUP_ARN`. No rewrite action, no
weighted multi-target-group forward. Writes
`.artifacts/engagement-phase2/<region>/preview-rule-created.json`.

Running `create-preview` again after success refuses — priority 6 is now
occupied — rather than creating a duplicate rule.

**Expected transient state:** between rule creation and a healthy service,
preview-header requests may return 503 (no registered targets yet). Ordinary
traffic must remain unaffected throughout. Do not tell users to try the
preview during this window.

### `verify-preview` — read-only

```bash
scripts/engagement-api-alb-rules.sh verify-preview
```

Asserts the rule at priority 6 is **exactly** the expected shape: the one
path condition, the one header condition with the exact name and value, a
single target group matching `ENGAGEMENT_TARGET_GROUP_ARN`, no rewrite, no
weighting. Rejects any additional condition or action. Idempotent — safe to
run repeatedly.

### `delete-preview` — mutating, immediate rollback step

```bash
export CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE=<the exact rule ARN from preview-rule-created.json>
scripts/engagement-api-alb-rules.sh delete-preview
```

Before deleting, the script re-fetches the rule by ARN and re-checks it still
has the exact expected condition and action shape. **If the rule drifted —
someone hand-edited it in the console — deletion is refused.** This is
deliberate: a script that deletes "the rule with this ARN" without checking
its current shape could delete something that no longer matches what it was
authorized to touch. After deletion, the script re-verifies the generic
`/api/*` rule is unchanged.

---

## Emergency removal (rollback, first step)

```bash
scripts/engagement-api-alb-rules.sh delete-preview
scripts/engagement-api-alb-rules.sh list   # confirm generic /api/* unchanged
```

Then verify the current product, per the rollback runbook. Do not touch the
generic rule. Do not scale the main API.

---

## Fail-closed guarantees, and how they're tested

| Guarantee | Mechanism | Test |
|---|---|---|
| Header is not treated as auth | documented; standard checks run downstream | — |
| No path-only Engagement rule | `verify-baseline` and `create-preview` both check | occupied/canonical-path negative controls |
| No Recall rule to engagement-api | checked before create | Recall-hijack negative control |
| Generic `/api/*` never touched | never in any command's `ALLOWED_OPERATIONS` | resource-type isolation, drift NC |
| No weighted/rewritten rule accepted as "the" rule | `analyze_rules` requires single target, `Type: forward` | rewrite/weight NC |
| Exact account/region/listener/priority/target group | every ARN's region checked against `AWS_REGION`; account checked via STS | wrong-account, wrong-region, wrong-target-group NCs |
| Create/delete need different tokens | `CONFIRM_..._CREATE` names account:region:priority; `CONFIRM_..._DELETE` names the exact rule ARN | token-refusal tests |
| No `modify-rule` ever | not in any command's allowlist — refused before the AWS binary runs | explicit assertion across all five commands |
| No delete of an unconfirmed/unknown rule | delete requires exact ARN equality with the recomputed expected rule | unknown-ARN and drift NCs |

All 29 assertions run against a **stateful** fake `aws` binary: create-rule and
delete-rule actually mutate an in-memory rule list, so "second create refuses
rather than duplicating" and "delete removes only the confirmed rule, others
survive" are proven against real state transitions, not static fixtures.

---

## A note on the header and the current web

The current production web must never send `X-Capiro-Engagement-Preview`. This
is asserted both here (a spec test scans `apps/web/src` for the literal
string) and in the Phase 1 runtime verifier's `assertNoWebPreviewRouting()`. A
future internal acceptance harness (2.12/2.18) may send it deliberately. The
attached Outreach V3 standalone prototype must not be modified to send live
requests in Phase 2 — it remains a design reference, not a client.
