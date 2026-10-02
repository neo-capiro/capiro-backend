# Meri production release — October 2, 2026

The three Meri service images were deployed to the sole `capiro-dev` AWS environment.
Web serves `https://os.capiro.ai` through `web-vnext`. Independent readback at
02:02:33 UTC verified the three image promotions. A second independent readback
at 02:31:39 UTC verified the final synthetic-cohort configuration, exact immutable
image digests and source labels, matching task definitions, and healthy ALB
targets. It made 28 read-only calls and no writes.

**Deployment: PASS. Provider recovery on retry: PASS. Strict exact-reply smoke:
BLOCKED by an added evidence disclaimer.** After the owner requested "Try again,"
both synthetic tenants received and displayed the expected reply and saved it.
Each completed one OpenAI call with no credit error, model-loop failure, tool
call, or stream error. The prior HTTP 429 credit failures remain preserved as
historical evidence. No production provider, model, routing, or application code
was changed for the retry. Full original-plan acceptance remains **NOT RUN**.

| Service | Qualified source | Image deployment | Healthy count |
| --- | --- | --- | --- |
| API | `83304d18e5a1ab647cf6f728392cf97b3058a832` | task definition 486 | 2/2 |
| Web vNext | `940fe9354f95630c6acb0f20f75ced26ea9e75f4` | task definition 386 | 1/1 |
| Meri orchestrator | `39cea28f31be07def2f67ddf06ac4c44ef4ab792` | task definition 87 | 1/1 |

Each service retains its actual build source. Later commits modify only tests,
operator scripts and release evidence; the images are not relabeled as those
newer commits. The exact digests and build/test records are in `qualification.md`
and `three-service-rollout-readback.json`. The final configuration readback is
`synthetic-canary-independent-final-readback-v2.json`; it supersedes the earlier
API 485 / orchestrator 86 task numbers without changing their images.

## Credit recovery retry

Fresh readback at 03:42:01 UTC confirmed the same three images, source labels,
configuration, deployment IDs and healthy ALB targets. The user-authorized retry
sent exactly two new turns: T1 at 03:45:57–03:46:09 and T2 at
03:51:39–03:51:47 UTC. T1 ran through Hermes/Bedrock Qwen; root directly executed
the remaining T2 wrapper. Both ordinary identities and the exact Web release
were verified. Both streams completed HTTP 201 / done with zero tools, stream
errors or blocked mutations; the expected phrase was visible and persisted.

Independent bounded logs verify one completed OpenAI `gpt-6-astra` call per
tenant, ten output tokens each, no partial/held/aborted result, and zero credit
errors or model-loop failures. No account balance query was made. See
`synthetic-retry-provider-runtime-readback.json` and its linked actual exit-0
collectors; the independent assertion summary is `synthetic-retry-summary.json`.

The saved response is 260 characters: the 26-character expected phrase plus an
`Evidence limitation` disclaimer about no/none/only/all/every claims requiring
source coverage. A read-only, exact-hash-bound inspection of the existing T2
reply identified that text without sending again. This is an additional public
disclaimer, not hidden metadata. Both original exact-equality assertions failed
and exited 1; they have not been loosened or relabeled as complete smoke passes.
The provider-credit blocker is resolved in the observed turns, while this
response-quality discrepancy remains for follow-up.
Source reconstruction reproduced the exact response hash: the claim-category
matcher treats `only` in the formatting instruction `Reply only` as a negative
or exhaustive factual claim. With no tool coverage, it appends the 232-character
disclosure even though the answer is only an acknowledgment. See
`synthetic-ui-v4-coverage-disclaimer-diagnosis.json` for exact deployed-source
lines and the exit-0 reconstruction. A future fix must distinguish formatting
instructions from factual absence/exhaustiveness claims while retaining real
coverage warnings; no production guard was weakened during this retry.

V4 consumed T1 only; V5 consumed the remaining T2 turn. V6 only inspected the
existing T2 conversation and also retains the inherited strict-equality failure
(its old error label mentions T1, but the actual row is T2). All three new known
sessions were revoked. Across initial attempts and this retry, exactly four
conversations/four turns were created; none remain in this retry's turn budget.
The full 75-case acceptance suite was not run. Every earlier result and lock
remains intact; new attempts have separate files and provenance.

## Database disposition

No migration or shared ledger change was performed in this release. The other
migration task had already completed the required schema: 449/449 API migrations
and 13/13 Workspace migrations, with zero unfinished ledger entries. Fresh
database and retired-schema upgrade rehearsals are preserved in this directory.
Do not rerun the historical 65-step recovery or restart PITR work.

The original whole-dump fingerprint discrepancy remains **ACCEPTED LIMITATION**
under the owner's October 2 deployment instruction. The original blocked receipt
was not rewritten as PASS. A narrower 681-section snapshot comparison passed;
that does not explain the earlier whole-dump mismatch. Bounded new-task logs show
no matched database startup error, but API log sampling was incomplete and does
not prove every database path. See `new-task-startup-assessment.json`.

## Release operator corrections and rollback

All source changes were integrated into C-drive local main before GitHub main.
PR1925 omits empty ECS task registration tags. PR1926 excludes the documented
`currentServiceDeployment` and `currentServiceRevisions` observation fields from
the service configuration fingerprint, while preserving actual deployment-ID,
task, scaling, network and unknown-setting drift checks. The 37 release tests
passed, independently rerun. PR1927 permits optional empty environment strings
in the synthetic flag operator while preserving strict database/source/secret
validation; 26 tests passed, independently rerun. No image rebuild was needed
for these operator-only fixes.

The first Web registration was rejected without creating a revision. The second
update succeeded but its old waiter stopped on the AWS observation fields.
Read-only historical reconstruction reproduced the original configuration hash
exactly; the correct Web candidate was healthy. Both original receipts remain
unchanged. `web-vnext-promotion-reconciled-receipt.json` is the separately verified
receipt for the fixed operator, with links by hash to the original and the
reconciliation. Its guarded rollback preflight was independently exercised up
to, but not through, `UpdateService`.

Application rollback images are pinned in the promotion receipts. Preserve the
forward database schema. The completed synthetic cohort change must be accounted
for before any application rollback. Reverting cohorts would itself create new
deployment IDs; restoring an earlier task definition is insufficient to reuse an
old promotion receipt. Independently reconcile and bind a rollback receipt to the
actual current deployment, task and configuration using reviewed evidence. Do not
bypass the operator's exact deployment-ID or configuration guards.

## Verification boundaries

The two approved synthetic tenants are `meri-foundation-20260928-t1` and `-t2`.
The image-owned fixed flag command ran successfully as diagnostic task definition
11 and verified `meriv3.fullChat=true` for precisely those two identities. Both
flags were previously absent. It used the served API's existing roles/network
and four-field database secret mechanism, with no shared migration ledger change.
The task's original before/after evidence is retained even when the subsequent
cohort operator stops; never repeat a completed flag write as a recovery step.

The task-local cohort operator encountered AWS empty-list response defaults and
a Python transport parameter-name collision. These are operator defects, not
evidence of a failed application rollout or database migration. Failed receipts
are preserved. Reconciled continuation must verify the original task command,
digest, exit and sanitized logs, reuse already registered definitions only after
their exact hashes match, and retain the transactional flag before-state proof.
The continuation completed successfully without repeating the database command.
`synthetic-canary-apply-v4.json` and the independent final readback verify API 486
and orchestrator 87. Their only configuration difference is the addition of the
two approved synthetic slugs: both cohorts grew from nine to eleven, preserving
every existing entry. Both deployments completed with zero pending tasks.

The first Hermes/Playwright attempt stopped during synthetic authentication:
Node exited 1, with zero conversation creations and zero chat turns. The Hermes
operator exited 0, which is not a browser-test PASS. Its original result and lock
are preserved. One browser mutation was blocked, but its endpoint was not captured;
this attempt does not establish a Meri product defect.
Read-only inspection then identified the test guard's incorrect Clerk hostname:
the deployed public configuration uses `clerk.app.capiro.ai`, while the first
driver allowed a different hostname. The production authentication configuration
was unchanged. See `synthetic-ui-auth-public-domain-diagnosis.json`.

The second Hermes/Playwright attempt verified the ordinary T1 identity, exact
Web release, and visible composer. It created one conversation and sent one turn:
HTTP 201, a completed stream, zero tool calls, zero stream errors, and zero
blocked mutations. Its session was revoked. The immediate exact-text visibility
assertion failed, so Node exited 1; Hermes exited 0. This attempt is **BLOCKED**,
not a complete UI PASS, and T2 was not attempted. T1 must not be resent to repair
an observation. See `synthetic-meri-ui-v2-attempt-observation.json`.

The final bounded check used only read access to T1's uniquely matched saved
conversation and the remaining single T2 turn. It confirmed that both tenants
persisted the same unexpected 119-character assistant reply, whose SHA-256 is
`5ba77f7c69f6a4776a4253c79aff36c243bbd44ac64303aaa3926a50be328703`.
Neither saved reply contains the expected phrase; a 15-second UI visibility wait
also failed. Thus the failure is not explained solely by the earlier React timing
weakness. Both identities, composers, exact Web source and persistence paths were
verified. T2 also completed HTTP 201 / done with zero tool calls, stream errors
or blocked mutations. Every known session from the two authenticated attempts
was revoked. Exactly two turns were submitted across all attempts, one per tenant.
Node exited 1 and the bounded live reply check is **BLOCKED**. The original T2
row's initialized `NOT RUN` verdict is stale after the failed final assertion;
its recorded counters and overall failure show that it did execute. Read
`synthetic-meri-ui-v3-smoke-result.json` and its command exit receipt together.

Source matching proved the identical reply is the MeriV3 general model-loop
failure fallback, not a differently worded model answer. Bounded orchestrator
logs then identified the same OpenAI HTTP 429 credit-exhaustion error in both
synthetic turn windows. No API database error was implicated in those windows.
The aggregate result is in `synthetic-meri-ui-aggregate-observation.json`; the
source identification is in `synthetic-ui-runtime-fallback-source.json`, with
`synthetic-chat-provider-diagnosis.json` preserving the actual runtime cause and
its read-only command exits.
Do not relabel the original failed browser receipts or repeat either used turn
as though it had never been submitted. Resume with a fresh reviewed observation
plan after the provider account is funded, retaining the two existing synthetic
conversations and immutable receipts.

Anonymous HTTPS checks for Web health, exact release identity, VNext surface and
Meri SPA delivery passed. The original full File01 acceptance suite is **NOT RUN**
by the rollout health checks. Authenticated synthetic QA has its own result and
must not be inferred from image builds or ECS health.
The [remaining original-plan acceptance inventory](../../handover/2026-09-30/remaining-file01.md)
describes the broader missing cases and capture/fixture work. Its historical
release hold is superseded by this attended release and accepted limitation;
its unexecuted acceptance cases are not thereby passed.

Research Portfolio Meri tools remain disabled pending qualification of the
separate Engagement release. Canonical `web` at `app.capiro.ai` and Engagement
were unchanged during the independently recorded verification window.

Shared policy: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`; machine map dated
2026-09-30 00:21 UTC. Evidence JSONs retain their original observation times.
Hashes recorded for local evidence describe those original bytes; Git's line
ending normalization may change the hash of a checked-out copy.
