# MeriV2 Persisted Policy-Pack Operations

## Purpose

This runbook governs the persisted compliance-policy lifecycle used by Meri action proposals and destination-side assurance. It covers draft, independent review, second approval, simulation, publication, retirement, rollback, selected-version evidence, and the `off → shadow → enforce` source rollout.

No policy pack was created, reviewed, published, retired, or rolled back by the Phase 20 implementation task.

## Core invariants

1. Only `user_admin` and `capiro_admin` may use the policy-pack administration API.
2. A pack owner cannot be its first reviewer.
3. When four-eyes review is required, the second approver must differ from both owner and first reviewer.
4. Reviewed decision material is immutable. Change it by drafting a new version.
5. A `nonProduction=true` pack cannot be published.
6. Published packs require review attribution and an accepted legal-review status.
7. At most one version of a pack key is published for a tenant.
8. Simulation is never bindable and never authorizes an action.
9. Every authoritative action decision records pack key/version/rule, outcome, source, mode, binding, context hash, decision hash, actor, effective user, and effective time.
10. Rollback publishes a previously reviewed target and retires the current version; it never edits a published row in place.
11. No disabled/sample legal policy may be seeded or activated.

## Modes

`MERI_POLICY_PACK_SOURCE` accepts only:

| Value         | Authoritative decision           | Persisted behavior                                                |
| ------------- | -------------------------------- | ----------------------------------------------------------------- |
| unset / `off` | reviewed static product baseline | persisted packs are not selected for live actions                 |
| `shadow`      | reviewed static product baseline | persisted selection and outcome are evaluated for comparison only |
| `enforce`     | verified tenant-published pack   | missing, invalid, tampered, or unavailable policy fails closed    |

Move `off → shadow → enforce`. Roll back `enforce → shadow → off` unless the incident requires continued fail-closed behavior.

## Operator setup

Use a dedicated administrator identity and the server-resolved tenant organization. Do not persist the Clerk JWT in the evidence package.

```bash
export API_ORIGIN=https://<approved-host>
export TOKEN=<short-lived-capiro-jwt>
export EVIDENCE_DIR="evidence/policy-pack-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
```

Use `curl --fail-with-body --silent --show-error`. Redirect only bounded JSON responses; never run with `-v` because it can print the authorization header.

## Step 1 — Inspect current packs and recent decisions

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $TOKEN" \
  "$API_ORIGIN/api/clio/policy-packs" \
  | tee "$EVIDENCE_DIR/01-packs.json"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $TOKEN" \
  "$API_ORIGIN/api/clio/policy-packs/decisions/recent" \
  | tee "$EVIDENCE_DIR/01-decisions.json"
```

Record current published pack keys/versions, effective windows, legal-review state, reviewer identities, rules hashes, and whether the live source is `off`, `shadow`, or `enforce`.

Stop if multiple versions of one pack key appear published, a published pack lacks attribution, a rules hash does not match its rules, or the currently selected decision cannot be explained.

## Step 2 — Seed the reviewed generic baseline only when required

The baseline endpoint is idempotent and administrator-only:

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  "$API_ORIGIN/api/clio/policy-packs/seed-baseline" \
  | tee "$EVIDENCE_DIR/02-seed-baseline.json"
```

Do not use this endpoint to seed disabled legal examples. Confirm the returned pack identity and lifecycle state before proceeding.

## Step 3 — Create a draft version

Create a new version instead of editing reviewed material. Example request shape:

```bash
cat > "$EVIDENCE_DIR/03-create-request.json" <<'JSON'
{
  "packKey": "generic-ga-policy",
  "version": "vNEXT",
  "jurisdiction": "all",
  "legalReviewStatus": "pending",
  "authority": {
    "source": "approved_product_policy",
    "reviewed": true
  },
  "effectiveFrom": "2026-08-01T00:00:00.000Z",
  "effectiveUntil": null,
  "fourEyesRequired": true,
  "rules": [],
  "fallback": "WARN",
  "nonProduction": true
}
JSON

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @"$EVIDENCE_DIR/03-create-request.json" \
  "$API_ORIGIN/api/clio/policy-packs" \
  | tee "$EVIDENCE_DIR/03-created.json"
```

The example contains no production rules and intentionally remains non-production. Replace it only with the reviewed change-ticket material. The response supplies the pack row ID used below:

```bash
export PACK_ID=<draft-pack-row-uuid>
```

## Step 4 — Revise while still draft

Only draft decision material may be revised:

```http
PATCH /api/clio/policy-packs/<pack-id>
Content-Type: application/json

{
  "jurisdiction": "all",
  "legalReviewStatus": "pending",
  "authority": { ... },
  "effectiveFrom": "<iso timestamp>",
  "effectiveUntil": null,
  "fourEyesRequired": true,
  "rules": [ ... ],
  "fallback": "WARN",
  "nonProduction": true
}
```

After each revision, independently recompute/review the displayed rules hash and retain the reviewed request. Do not include customer data, prompts, or generated prose in policy rules or evidence.

## Step 5 — Submit for independent review

The owner submits the completed draft:

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"Ready for independent policy and legal review under change <ticket>."}' \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/submit-review" \
  | tee "$EVIDENCE_DIR/05-submit-review.json"
```

Once review starts, changing jurisdiction, authority, effective window, four-eyes setting, rules, fallback, non-production status, or rules hash must fail. Draft a new version if the reviewed material needs revision.

## Step 6 — First independent review

A different administrator identity performs first review and records one of the accepted review states:

```bash
export REVIEWER_TOKEN=<different-short-lived-capiro-jwt>

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $REVIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "legalReviewStatus":"approved",
    "reason":"Independent policy/legal review completed under change <ticket>."
  }' \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/review" \
  | tee "$EVIDENCE_DIR/06-first-review.json"
```

`not_required_product_policy` is valid only when the approved governance process determines legal review is not required. Do not use it merely to bypass a pending review.

A self-review attempt must fail and increment the segregation-of-duties control evidence.

## Step 7 — Independent second approval

When `fourEyesRequired=true`, a third identity—not the owner and not the first reviewer—performs second approval:

```bash
export SECOND_REVIEWER_TOKEN=<third-short-lived-capiro-jwt>

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $SECOND_REVIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"Independent second approval completed under change <ticket>."}' \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/second-approve" \
  | tee "$EVIDENCE_DIR/07-second-approval.json"
```

The database trigger prevents a concurrent or stale writer from replacing the reviewer who won the row lock.

## Step 8 — Simulate before publication

Simulation evaluates the exact draft/reviewed row against an action context but returns `simulated=true`, `bindable=false`, `binding=null`, and `decisionHash=null`.

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $REVIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "tool":"send_email",
    "input":{"jurisdiction":"federal","recipient":"test@example.invalid"},
    "jurisdiction":"federal"
  }' \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/simulate" \
  | tee "$EVIDENCE_DIR/08-simulation.json"
```

Use synthetic/non-customer inputs for simulation evidence. Confirm expected PASS/WARN/BLOCK behavior, selected rule, fallback, jurisdiction, and effective window. A simulation never substitutes for the action proposal’s live policy decision.

## Step 9 — Make a reviewed pack production-eligible

A pack cannot publish while `nonProduction=true`. The production-eligible version and its decision material must be established through the approved lifecycle. Because reviewed decision material is immutable, do not patch a reviewed row merely to clear `nonProduction`. Prepare and review the production-eligible version according to the service’s lifecycle and test evidence.

Stop if publication eligibility requires bypassing the lifecycle trigger or manual SQL.

## Step 10 — Publish

Publication requires all lifecycle, legal-review, four-eyes, effective-window, integrity, and attribution checks:

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $SECOND_REVIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"Approved for publication under change <ticket>."}' \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/publish" \
  | tee "$EVIDENCE_DIR/10-publish.json"
```

Verify exactly one published version for the pack key and inspect its event history:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $SECOND_REVIEWER_TOKEN" \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/events" \
  | tee "$EVIDENCE_DIR/10-events.json"
```

## Step 11 — Shadow rollout

Set:

```text
MERI_POLICY_PACK_SOURCE=shadow
```

The static reviewed baseline remains authoritative. During the observation window verify:

- persisted pack selection succeeds for expected jurisdictions/effective windows;
- rules hashes match;
- no disabled or non-production pack is selectable;
- shadow outcome differences are reviewed;
- policy decision evidence contains no action body or customer prose;
- downstream assurance displays the expected pack/version/rule;
- no `PolicyDriftInvalidations` alarm is unexplained.

## Step 12 — Enforce rollout

Only after accepted shadow evidence:

```text
MERI_POLICY_PACK_SOURCE=enforce
```

In enforce mode, missing, invalid, tampered, unavailable, or non-selectable persisted policy fails closed. Verify real internal proposals before external-action surfaces. Confirm the decision row and action proposal bind the same pack/version/rule, context hash, and decision hash.

## Retire a pack

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $REVIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"Retired under change <ticket>."}' \
  "$API_ORIGIN/api/clio/policy-packs/$PACK_ID/retire" \
  | tee "$EVIDENCE_DIR/retire.json"
```

Do not retire the only authoritative pack while live source mode is enforce unless the intended fail-closed outage is approved or a replacement is published atomically through the supported service path.

## Roll back to a prior reviewed version

Set identifiers from the approved event history:

```bash
export CURRENT_PACK_ID=<current-published-row-uuid>
export TARGET_PACK_ID=<prior-reviewed-row-uuid>

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $SECOND_REVIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"Rollback under incident/change <ticket>."}' \
  "$API_ORIGIN/api/clio/policy-packs/$CURRENT_PACK_ID/rollback/$TARGET_PACK_ID" \
  | tee "$EVIDENCE_DIR/rollback.json"
```

Verify the current version is retired, target is published, event ledger names both versions, and new decisions bind the target. Previously approved actions with stale policy binding must be regenerated/reapproved; do not mutate their binding.

## Emergency source rollback

When persisted policy loading is the incident:

1. set `MERI_POLICY_PACK_SOURCE=shadow` so the reviewed static baseline becomes authoritative while persisted behavior remains observable;
2. if shadow evaluation itself causes harm, set `off` or unset;
3. preserve pack rows and event/decision evidence;
4. do not manually change pack status or rules hash;
5. investigate and repair through a new version/change.

## Evidence closeout

Retain bounded responses for list, create/revise, submit, reviews, simulation, publication, events, shadow comparison, enforce decision, retirement/rollback, and the exact mode/task-definition timeline. Never retain JWTs, cookies, customer message bodies, prompts, provider payloads, or raw tool inputs in the evidence package.
