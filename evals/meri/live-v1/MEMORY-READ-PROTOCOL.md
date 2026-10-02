# Ordinary original memory cases 02–05

One shared protocol collects the four original prompts over the ordinary
authenticated `/api/clio/conversations/:id/stream` route. It does not make a
request during import/preparation, create sessions/conversations/fixtures, or
turn a saved response into a source-authority or human-review claim.

The root operator owns real authentication, current deployed-image readbacks,
an empty Pat/Aster conversation for each case, and one shared spending owner.
The current first case01 attempt and immutable reservation must be reconciled
before any of these cases. Never retry a submitted turn after an uncertain
response or initialize another ledger to escape retained uncertainty.

## What the original plan requires

Appendix G section3 explicitly permits authenticated API/streaming clients for
factual cases. Appendix F requires actual scope, fixtures, trace/tool/source
evidence, persisted objects, exact row assertions and a separate human rubric.
Appendix G section7 requires an explicit cost limit, concurrency (initially1),
timeout and cleanup. It does not prescribe numeric $3/$30 limits, HMAC envelopes,
Windows opaque capabilities or a bespoke wrapper per case.

The current task's **$3 maximum/case, $30 original-slice ceiling**, retained first
reservation, concurrency1 and actual provider-attempt accounting remain in
force. Numeric ceilings can be lower where the shared owner qualifies them.
`MeriRunBudget` call limits alone are not a dollar cap. The existing case01
capture admission must not be relabeled as02,03,04 or05.

## Source-owned corpus readback

Use the existing `createCase01SetupDependencies` minimal factory from
`apps/api/scripts/meri-case01-setup-dependencies.mjs`. Supply the actual approved
Pat context from the private manifest, including Clerk user ID, to its
`runWithTenant`. Within it call:

```js
const proof = await readCurrentMemoryCorpus(factory.deps, actualPatContext, actualAsterId);
```

This reuses the hydrated five-source owner and canonical current version,
revocation, pending-candidate, client-wall and reset guards. It performs locking
reads, not SQL writes, seeds, projection, a new claim or a capture binding update.
The owner name/corpus identifier remains01; the collected case remains02–05.
The original successful setup receipt is a locator for inspection, not evidence
that rows remain current. Capture the complete fresh proof before and after each
turn. The one-entry MA1-v2 `sourceMap` alone is insufficient: the current proof
also verifies the pending/revoked/superseded/Bluehaven corpus.

The readback reconstructs from the current canonical locator and rows even when
another case has replaced `captureEvidence`. It explicitly returns
`captureAuthority: false`; existing case01 capture admission still requires its
own exact binding. A missing/changed locator or invalid current actor, source or
lifecycle refuses. A reconstructable historical audit-version change produces
a different current hash, so the protocol detects before/after drift; it is not
a claim that the original binding still matches. Do not restore stale tenant
settings or treat this corpus evidence as provider admission.

The frozen specification says reset relevant state before each case. For these
read-only rows, a fresh unchanged-baseline readback may be recorded as such; it
must not be called a newly executed reset. If relevant state changed, stop and
use the canonical retirement/setup owner; never reseed a retained partial claim.

## Root invocation shape

```js
import { executeMemoryReadCase } from './memory-read-protocol.mjs';
import { createMemoryReadHttp, createMemoryReadRecorder } from './memory-read-http.mjs';

// Values come from actual approved identity/setup/build receipts, not examples.
const record = await createMemoryReadRecorder(newExclusiveEvidenceDirectory, {
  secrets: [freshSyntheticBearer],
});
const transport = createMemoryReadHttp({
  bearer: freshSyntheticBearer,
  conversationId: config.conversationId,
  timeoutMs: config.timeoutMs,
});
const observation = await executeMemoryReadCase(config, {
  transport,
  record,
  readCurrentFixture: actualCanonicalReadback,
  spend: actualSharedSpendOwnerAdapter,
});
```

`config` has exactly `caseId`, `captureRunId`, `conversationId`, `actorUserId`,
`clerkUserId`, `clientId`, `apiSha`, `orchestratorSha`, `webSha`, `maxCostMicros`,
`timeoutMs`. Scope is fixed to approved T1/Pat/Aster/Standard; original prompt
text is loaded from `cases.mjs`. Root independently verifies current immutable
API/Orchestrator/Web sources before invoking this code; the API header is checked
again on each response. Auth is supplied only in RAM; root must revoke it finally.

The shared budget adapter must implement:

- `beforeSubmit({caseId,captureRunId,conversationId,maxCostMicros})`: assert the
  actual server-enforced qualification, reserve against the one existing slice,
  and return its reservation object. Null/absent/boolean results cannot dispatch.
- `afterAttempt(reservation,{submissionAttempted,httpStatus,completed,runIds,
responseHashes,savedMessageHashes})`: record the observation and independently
  reconcile the server's actual provider ledger. Plain callback usage does not
  settle spending. Retain uncertainty until the real terminal proof is available.

These are trusted operator ports, not untrusted request parameters. The production
shared budget-only bridge is a separate dependency and is not supplied here.
Do not use UNIT test ports or an object-returning placeholder in a live operator.
Until that bridge is qualified, this module is executable collection code with a
missing execution prerequisite, not permission to run without enforced cost.

The native transport permits only the fixed identity/status/owned conversation
GETs and one stream POST, uses TLS, the reviewed User-Agent, no redirects, an8MiB
response limit and a total900s maximum deadline. It preserves rejected HTTP
responses before classifying them. POST ambiguity never triggers a retry.
Evidence filenames are exclusive; credentials and token-shaped data are rejected.
Profile fields and pre-existing conversation bodies are not copied during scope
preflight. Only synthetic answer/tool evidence may be retained afterward.

## Review and result reporting

The collector returns `COLLECTED_NOT_GRADED`, `BLOCKED_BEFORE_SUBMISSION`, or
`ATTEMPT_REQUIRES_RECONCILIATION`, always with `overallCaseStatus: NOT_RUN` and
`humanRubric: NOT_REVIEWED`. These are collection states, not verdicts about the
product. HTTP/identity/persistence/corpus checks are explicitly machine checks.
Record actual failed assertions immediately as FAIL in the case report; missing
evidence remains NOT_RUN/BLOCKED and does not erase a known failure.

| Case | Required original review                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 02   | Fresh MA2 pending governance state; SMS is not asserted as approved; pending status is correct when the tested actor is authorized to see it. |
| 03   | Fresh canonical MA3 revocation; no recommendation based on revoked Office Delta memory; no revoked text in citations.                         |
| 04   | Real MA1-v1→v2 chain; monthly is current; weekly is not presented as current.                                                                 |
| 05   | Actual MB1 forbidden IDs/facts/passages versus delivered answer and user-visible trace; no Bluehaven inference under selected Aster.          |

Also inspect actual tool/source IDs, current scope, passage and citation versions,
run/trace identities, provider usage/cost and resulting business effects. An
unchanged memory corpus does **not** prove absence of unrelated task/document or
other writes; an independent current effect readback is still required. Do not
mark empty tool arrays or missing usage as observed zero. The existing pure
`memory-row-predicates.mjs` may assist02/04/05 only after real evidence is mapped;
do not manufacture its required trace/source records from the expected answer.

Keep human grading separate: five dimensions0–2, total>=8 and no zero, tied to
the actual saved answer/evidence and reviewer. Codex review is labelled Codex;
it is not a human record. No new model judge runs are required by this module.

## Local checks

```powershell
$env:MERI_PROTOCOL_TEST_ROOT='C:\dev\cap-meri-foundation-evidence'
node --test evals/meri/live-v1/tests/memory-read-protocol.test.mjs
```

These are UNIT protocol/filesystem checks. They make no authenticated, AWS,
database, provider or live Meri request and cannot establish an original-row pass.
