# Original File01 case 14: approval in Meri, then recall

This path implements Appendix F row 14 of the original Foundation and Reliability plan. It does not mark the row passed without an actual deployed run. Case 14 uses Pat's single frozen `MEM-PROPOSAL-14` candidate, approved by the existing Priya reviewer (`user_admin`). It does not grant permissions, change roles, or navigate to Settings.

The frozen candidate text is `Synthetic Aster candidate for approval`. The original action is approval; the single subsequent read-only recall prompt is `What is the recently approved Aster memory? Cite its source.` Approval occurs through the actual Meri Memory UI and existing review API. The recall capture policy remains read-only.

## Required deployment and inputs

- API and orchestrator must contain the case 14 receipt boundary and current-source dispatch. An older orchestrator cannot validate `case14_memory_turn` receipts. The Web UI is unchanged but its actual source/digest must be qualified too.
- Target only `https://os.capiro.ai`, `capiro-dev`, namespace `meri-foundation-20260928`, approved T1. Use current authenticated Priya identity and its existing Clerk organization membership. The source checks current membership, role, client walls, canonical decision permissions and exact fixture ownership; configuration cannot assert those checks passed.
- The ordinary Pat pending setup recipe uses the same source-owned actor/client manifest mapping as case 17, but `caseId: '14'`, Pat's `standard_user` context, and a fresh fixture instance UUID. Existing setup claims refuse replay. No seed or approval runs as part of tests or module import.
- Keep credentials process-private. The browser callbacks only mint one ephemeral sign-in ticket for the exact existing synthetic actor and record a new session ID for independent cleanup. They receive no browser page or transport capability. The source signs out its session; the operator must independently confirm/revoke that known session if the process fails.
- All live operations remain root/operator actions. Offline tests are not production acceptance.

## Bounded execution

1. Run the existing fixed `meri-pending-memory-setup plan|execute` CLI with `{recipe, expectedPlanSha256}` for case 14. The setup creates exactly one pending candidate through the canonical source method. Do not reuse a case 17 recipe or repair an occupied claim blindly.
2. Initialize a fresh task-owned Windows artifact storage root using `createWindowsArtifactStorage(...).init(ownerBytes, markerBytes)`. Call `collectCase14ApprovalCapture` from `evals/meri/live-v1/case14-approval-capture.mjs` with the configuration below and the two auth callbacks. It opens Meri, observes the exact pending candidate, clicks Approve once, joins the successful API response to current canonical approval/audit evidence, and saves both immediate and reloaded durable UI receipts. It permits zero synthesis turns. An interrupted attempt must be reconciled; never invoke the approval again automatically.
3. Bind the already approved source using the fixed `meri-case14-recall-setup plan|bind` entrypoint. The nonsecret input is `{ctx, caseId:'14', clientId, captureRunId}` for plan; bind adds the exact `expectedPlanSha256` and `confirmation:'BIND_EXISTING_CASE14_CANONICAL_APPROVAL'`. Here `ctx` is Priya's real current context, including `clerkUserId`. Supported ingress is `--input ABS_JSON` or `--input-env MERI_CASE14_RECALL_SETUP_INPUT`, with `--out ABS_NEW_JSON`. The CLI prints `MERI_CASE14_RECALL_SETUP_RECEIPT ` followed by its sanitized structured receipt. It only replaces the owned capture binding and clears old provider qualification; it does not approve, alter, delete, or reseed memory. It refuses stale source/row/settings/run reuse. Preserve its source map and typed seed/reset IDs.
4. Use `meri-capture-provider-budget plan|install` with the same actual context/client and explicit `caseId:'14'`. The input includes reviewed provider rates and their expiry, exact current binding/source hash, prior qualification hash and tenant row version. No prices, permissions or budgets are inferred. The trusted ceiling remains at most USD 3 per case; the actual operator may choose a lower ceiling. The rate evidence must cover the policy lifetime. See `capture-provider-budget.md` for the installer schema.
5. With one fresh ordinary Priya bearer token held only in memory, call `createCase14RecallConversation({approvalOutcome,config,artifactStorage,env})`. It uses the existing authenticated conversation POST exactly once with Aster and the fixed namespace/case/run title. It records an exclusive intent before dispatch and the acknowledged returned owned row. It does not send. Preserve uncertain results and reconcile instead of repeating it. Use the returned conversation ID for the next step.
6. Prepare a separate fresh, **uninitialized** Windows storage instance for the native recall collector; `ArtifactCollector.init` initializes that root. Call `prepareCase14RecallCapture` then `executeCase14RecallCapture` from `case01-live-capture.mjs`. The closed case 14 entrypoint shares the existing native HTTPS/build/receipt machinery with case 01. It independently checks `/api/me`, current conversation admission, physical approved item/version, price qualification, and an empty conversation immediately before submitting exactly one recall turn. It re-reads the saved answer, actual source passage and authenticated signed receipt/current owner. It never accepts a caller-supplied readiness boolean or internal-service secret. Unknown outcome must not be retried.
7. Initialize another owned storage root and call `collectCase14RecallUi` with the opaque recall outcome and the same case configuration/auth callbacks. This opens only the existing conversation and observes the visible saved reply. It permits no application writes or new turn, and revokes its new session.
8. In the **same process** that owns those three opaque outcomes, call `gradeCase14CapturedOutcome({approvalOutcome,recallOutcome,recallUiOutcome,visualReview})`. It joins the real approval audit to the recalled physical item/version, citations/passages, provider budget and visible saved answer. It never prompts a model or sends another turn. Copied JSON cannot reconstruct any capture capability. Preserve the process until saved visual review is supplied.

## Configuration

Approval/UI configuration:

```js
{
  schemaVersion: 1,
  caseId: '14',
  target: 'https://os.capiro.ai',
  captureRunId: '<fresh UUIDv4, reused across this approval/recall slice>',
  recipe: { /* exact source-owned case14 Pat pending setup recipe */ },
  reviewer: { tenantId, tenantSlug, userId, clerkUserId, role: 'user_admin' },
  clerkOrganizationId: '<existing approved T1 org>',
  deployment: {
    apiSha, webSha,
    builds: { api: apiQualifiedBuild, 'web-vnext': webQualifiedBuild }
  },
  limits: { concurrency: 1, maxApprovalSubmissions: 1, maxSynthesisSubmissions: 0 }
}
```

Each qualified build names service, exact source SHA, successful CodeBuild ID, exact buildspec SHA256 and immutable image digest. The source verifies actual current task/ALB/build/ECR evidence, not just these caller fields.

Recall configuration follows the existing `prepareCase01LiveCapture` schema with the closed case 14 differences: `caseId:'14'`, Priya under `scope.actors.PRIYA` with its current `user_admin` role, Aster, and **only** `scope.sources['MEM-PROPOSAL-14']` from the actual binding receipt. Use the returned real conversation ID; the source map version is `candidate:<actual candidate UUID>` and the physical source is the canonically allocated approved memory item UUID. Pin actual API/orchestrator build qualifications; retain the frozen contract lock/hash/version. `env.MERI_LIVE_BEARER_TOKEN` remains process-private and is never written to evidence.

The visual review has kind `meri-case14-visual-review`, case/run/evidence SHA256 from the offline grader, reviewer/reference/rationale/reviewedAt, exact four screenshot hashes, and booleans `approvalAndDurableReceiptVisibleInMeri` and `nextTurnRecallAndCitationVisible`. Without this saved visual review, deterministic success reports `NOT_RUN` for overall row acceptance.

## Qualification boundaries

The current owner is rehydrated from the persisted source-validated pending recipe plus actual candidate/item/clio rows, current authorization and exact approval audit. A stored receipt or locator alone is insufficient. The API adds optional evidence only to the existing protected review detail for the exact approved synthetic case owner; ordinary responses and permissions remain unchanged.

The native clients send `User-Agent: Capiro-Meri-Authorized-QA/1.0` required by the current edge and retain the exact served-release response-header check. A missing/mismatched release header is a blocked run, never permission to assume the response came from the intended build.

The read-only provider ledger covers actual memory retrieval and synthesis ingress for case 14. The prior explicit approval is outside that read-only turn and is separately accounted once. Source-version, audit, wall, membership, ledger or binding changes fail closed. Other original rows and the global LIVE guard remain unchanged.
