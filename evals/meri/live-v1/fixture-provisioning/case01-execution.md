# Case01 setup, one capture, and grading

This operator prepares only original case01, on the already approved synthetic T1.
It does not execute a turn, enable flags, install provider prices, or claim acceptance.
Use the reviewed current API image, existing database secret references and network
configuration. The operator is not a general shell or migration runner.

## Setup recipe and commands

`meri-case01-setup plan|execute --input /absolute/recipe.json --out /absolute/new.jsonl`
is an API entrypoint verb. `--input-env MERI_CASE01_SETUP_INPUT` is the alternative
for an ECS one-off. Only that exact environment variable is accepted; its nonsecret
JSON is limited to 6,000 UTF-8 bytes. Use one input mode, never connection strings,
API keys, cookies, passwords, or bearer tokens. The entrypoint composes DATABASE_URL
privately from the existing injected DB_* variables.

Input is `{ "recipe": <object>, "expectedPlanSha256": <execute only> }`.
The recipe has these exact fields:

| Field | Required value |
| --- | --- |
| schemaVersion | 1 |
| target | capiro-dev |
| fixtureNamespace | meri-foundation-20260928 |
| ctx | Exact tenantId, tenantSlug, userId, role; T1, approved Pat, standard_user |
| clerkUserId | Current synthetic Pat Clerk identity, not a session/token |
| reviewerUserId | Existing independent synthetic Priya; canonical review authorization still runs |
| captureRunId | Fresh UUIDv4, also used by the later capture |
| previousFixtureInstanceId | Fresh UUIDv4 |
| currentFixtureInstanceId | A different fresh UUIDv4 |
| clients | Existing approved fixture mapping: ASTER/BLUEHAVEN T1 and CEDAR T2, each tenantId + physicalId |
| actors | Existing approved mapping, including PAT/PRIYA each physicalId |

`MERI_SYNTHETIC_FIXTURE_NAMESPACE` must equal the namespace. Existing governance
configuration must select the actual synthetic tenant. The factory binds the real
tenant context and separate governance AsyncLocalStorage; it never changes flags
or broadens the cohort to `all`. Preflight verifies active synthetic membership,
ordinary capture actor, independent reviewer, and both relevant client walls.
Only source-owned frozen fixture text and assets are loaded.

Run `plan` first. Review the output and pass its exact planSha256 to `execute`
with the unchanged recipe. A database-owned one-shot claim is committed before
the first fixture write. It is never cleared automatically. Existing claims,
changed tenant settings/row versions, or uncertain prior operations stop execution.

Execution calls actual canonical owners in this order:

1. Seed the previous five-source corpus, retire its eligible sources and pending proposal.
2. Seed a new corpus linked to that actual retirement; canonical approval allocates IDs.
3. Re-read current canonical authority and bind captureEvidence with its CAS tokens.
4. Install the restart locator, reconstructing canonical history instead of trusting receipts.
5. Create an actual owned, empty Aster conversation through MeriService and re-read it.

Canonical audit/outbox writes and real projection behavior are retained. The setup
receipt explicitly does not qualify projection/retrieval or LIVE acceptance. Provider
calls made by fixture projection are setup work, not a captured chat turn.

The output file is created exclusively and contains a synced JSONL journal. Every
safe stage record is also emitted as `MERI_CASE01_SETUP_RECEIPT <json>`. Root can
retain actual CloudWatch bytes plus the one-off exit status after the task exits.
The final COMPLETE record contains the exact setup receipt, current physical map,
seed/reset IDs, binding hash, locator hash, conversation ID, and zero submitted turns.
Failure leaves the claim and stage journal for reconciliation; do not retry with a
new output path or manufacture a resume receipt.

## Provider qualification is a separate existing operator

After successful setup, use `meri-capture-provider-budget plan|install` with
`--input /absolute/input.json` or the fixed
`--input-env MERI_CAPTURE_PROVIDER_BUDGET_INPUT`, and `--out /absolute/new.json`.
The safe full receipt is emitted as `MERI_CAPTURE_PROVIDER_BUDGET_RECEIPT <json>`.
See [capture-provider-budget.md](capture-provider-budget.md) for its exact CAS,
reviewed rates, maxTokens equality, rateEvidenceExpiresAt, and maximum 3 USD contract.
No rate or budget default is installed by setup. The setup receipt is not a substitute
for the installer's fresh canonical owner readback.

## One actual capture, then offline grading

Use the existing source-owned `case01-live-capture.mjs` functions with a verified
native Windows artifact owner. Configure the exact setup conversation/run/map and
actual immutable deployed build proofs, existing approved ordinary actor bearer
in process, concurrency 1, deadline at most 900 seconds, and explicit spend <=3 USD.
`prepareCase01LiveCapture` performs read-only qualification;
`executeCase01LiveCapture` consumes that capability once and submits one frozen prompt.
Keep the process-owned artifact capability open. Never serialize and re-adopt a
capture outcome; a plain JSON copy is deliberately rejected.

Call `gradeCase01CapturedOutcome(outcome)` from `grade-case01-capture.mjs` in that
same process. It re-reads immutable artifact hashes and the already authenticated
source/auth/build/tool/effect/usage joins. It does not call a model, browser, or API.
Case01 facts require monthly, fiscal year (or FY), budget stage, citations, and
action owner. The eligible source/version is established by actual physical
citation/canonical byte joins; literal `MA1-v2` prose is not required. Missing or
wrong-version/foreign citations still fail. Facts/leak defects produce FAIL.

Without a manual rubric the result is NOT_RUN with deterministicStatus PASS and
HUMAN_ADJUDICATION_REQUIRED. A separately supplied human record has schemaVersion1,
kind `meri-case01-human-adjudication`, nonblank reviewer/rationale, ISO reviewedAt
at or after the signed receipt's completion and not in the future, exact
captureRunId/caseId/turnId/answerSha256/evidenceSha256, and these five integer scores:
factual_support, evidence_coverage_citation_validity, client_relevance,
directness_clarity, actionable_judgment. Each is 0..2; every dimension must be >=1
and total >=8. Do not fabricate a human record or label model self-grading as human.

Only case01 can pass this composition. `fullFile01Acceptance` remains false.
Other original cases, missing fixtures, interrupted captures and unsupported
authority remain blocked. Re-grading never authorizes a second live turn.
