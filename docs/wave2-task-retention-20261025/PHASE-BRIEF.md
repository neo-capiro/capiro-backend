## 1. Claude handles the harness

The quality bar is Claude's own. Answer quality comes from the whole harness, not only the model: its system prompt, built-in tools, subagents, skills, context management and compaction, and session handling.

- Run `@anthropic-ai/claude-agent-sdk` with its **full harness** and the Claude Code system-prompt preset, plus a short Capiro/Meri append. Don't replace the preset with our own prose.
- Do not rebuild what the SDK or AWS already does: model calls, retries, streaming, the tool loop, context management and compaction, session resume/fork, per-run turn and spend limits, AWS credentials.
- The real Claude SDK calls Bedrock directly using its narrowly scoped AgentCore runtime IAM role. Preserve the full preset, native tools, subagents and all 14 skills.
- Capiro data reaches Claude as **tools** (rule 4), not as a custom retrieval layer around the model.

Spec and plan: `phases/wave2/WAVE2-00-CLAUDE-NATIVE-HARNESS-SPEC.md`. It is **Wave 2 item 0**, and it comes before every other item that touches the runner, the proxy or authority.

## 2. Simple, standard architecture

```text
browser -> control (current access, conversation/run ownership, durable events)
        -> AgentCore Runtime V1 (isolated conversation session; actual Claude SDK) -> Bedrock
                                      -> tool gateway -> Core
control -> existing durable SDK SessionStore and artifact owners
control -> Temporal for required durable runs, schedules and background work
```

- **Core is the gatekeeper for Capiro data.** Tenant, member, client and wall rules remain server-side in Core. Check current access at admission and actual tool/data/artifact access; revocation must also prevent use of previously loaded privileged context. Do not duplicate policy in the harness.
- Reuse one isolated environment only for the same immutable tenant/actor/conversation and approved General/client scope. Serialize turns; stop idle compute and restore exact SDK transcripts and artifacts from their durable owners. A Runtime session ID is not authorization or durable storage.
- Keep the SDK's per-run turn/spend limits and one canonical tenant cap/usage owner. Preserve required durable runs, schedules, consent, outcomes and uncertain-write fences; neither SDK Task tools nor a warm process replaces Temporal durability.
- **No custom warm pool, per-turn ECS task requirement, model proxy, duplicated per-hop authority, credential-minting service or spend-reservation ledger.** Use standard Runtime V1; no V2 snapshot machinery or second SDK implementation.
- Before adding a mechanism, identify the standard feature or existing owner it uses. Before deleting a wrapper, prove the retained lower-layer behavior with meaningful positive/negative tests. Do not remove canonical authorization, idempotency or durable outcomes as “extra security.”

## 3. Leave no dead code behind

A change is not done until what it replaced is gone.

1. **Delete in the same PR** everything the change makes unused: code, tests, fixtures, docs, config keys, env vars, feature flags, IAM statements, ALB rules, secrets, task definitions, CloudFormation resources, kit steps, alarms and metric filters. Applied database migrations are history: never edit them. Drop tables only through a separately reviewed forward migration after a snapshot; this hosting migration does not itself authorize schema/data removal.
2. **Temporary diagnostics come out before merge** of the fix they were added for. A log line stays only as named product telemetry that someone reads.
3. **No code behind a flag nothing turns on.** The "source-complete, activation-held" status is retired for code we don't intend to ship. Dark features need an owner and a date, or they are deleted.
4. **No** commented-out code, `legacy` or `_old` copies, compatibility shims for removed things, or "superseded" stubs.
5. **Show proof in the PR:** list the identifiers, files and resources deleted, with a search proving no executable/active caller remains; label immutable historical references, and explain any drop in test count.
6. **Old plan tickets for removed mechanisms are closed as superseded**, not implemented and left dormant. See `source-of-truth/SUPERSEDED-BY-ITEM-0.md`.
7. **Reuse before write.** Use SDK, AWS and library features first. Custom code needs one line saying what the standard option couldn't do.

## 4. Capiro data must keep working

- Capiro data is served to Claude as tools. Core remains the source: today's read families call Core at `/api/clio/tools/<operation>`, and the new tools call the same endpoints.
- Tools are hosted by **control** (the existing tool gateway) so the runner never holds the Core service secret (`x-internal-service-secret`). The runner gets only a short-lived per-run token for control, scoped to tenant, user, client, conversation and run.
- Reuse the existing read handlers under `apps/gateway/sources/*` and their typed schemas. Delete the authority, relay and measurement wrappers around them.
- Parity: every read family that works today must be reachable as a tool with the same results and the same permission outcomes. A parity checklist is part of the item 0 spec.
- Negative tests are mandatory: another tenant's data, another client's data, and walled data must not be retrievable, through chat or through tools. A General chat reads across the clients the user can already see, with each client's wall enforced per result (FINAL-PLAN decision 2).
- The original read-only first cut is historical. Neo subsequently authorized preview client-record writes and autonomous Wave 2 completion. Activate accepted writes through their existing authenticated domain/intent owners and receipts, with the actual route/configuration and effect semantics verified. This does not authorize the assistant to send external mail without the user's specific send instruction.

# Wave 2 canonical task replacement retention — PROCESS 6.1 brief

FROM: Root | TO: Integration | TYPE: brief | RE: bounded infrastructure source alignment

This is one brief for the same five existing ECS TaskDefinition resources across three repositories. It is copied unchanged into each draft PR. Integration owns the three named source files and this brief; Supporting independently reviews the exact heads. Root coordinates integration and merges. The existing Release continuation alone owns AWS, configuration, material and rollout. Root operates at Ultra and helpers at xhigh under the current allocation.

## Exact source allocation and dependencies

Fresh remote fetches matched all allocated normal heads without deviation:

| Repository / base | Base SHA | Owned branch / checkout | Owned source and resource |
| --- | --- | --- | --- |
| capiro-backend / backend-import | 929acd023c29d9073cbf9d5c5105eba8c3252948 | codex/wave2-retain-core-20261025 / C:/dev/w2-retain-core-20261025 | infra/cdk/lib/preview/first-chat-core.ts — ServeTaskF1990141 |
| meri-greenfield / main | 09e89db9b57c8fcb5b1aa15a4d1479074c8bbe16 | codex/wave2-retain-meri-20261025 / C:/dev/w2-retain-meri-20261025 | infra/product-preview/manifest.mjs — controlTask, temporalWorkerTask, scheduleWorkerTask |
| capiro-frontend / main | 1dfd5893525ad31b7e6622371b1d4e1ddb6bcbf1 | codex/wave2-retain-fe-20261025 / C:/dev/w2-retain-fe-20261025 | apps/web/deployment/portfolio/service.yml — PreviewTaskDefinition |

Dependency source pins remain those merged heads. This lane does not block or change the frozen corrective rollout or Release-owned files. Recheck an advanced integration base before merge and review any new delta. No other file ownership exception is granted. No #202 post, Hermes operation, delegation, application edit, cloud apply or merge is allocated.

## Decision, scope and standard mechanism

Root's current decision supersedes tentative instructions to remove temporary Retain after the rollout: standard `UpdateReplacePolicy: Retain` is a reusable rollback requirement and stays in the canonical generators for future deployments. Cleanup after the bounded rollback window deregisters only unneeded OLD physical revisions/material. It does not remove and re-add the policy each release, and it does not permit unbounded silent retention. Root/Release owns that existing bounded operational cleanup; this source PR schedules or executes none.

Add only this resource-level attribute to the five named resources. Core uses the existing L2 task's L1 `cfnOptions.updateReplacePolicy`; Meri uses the existing three-role task factory's L1 option; frontend uses its existing YAML resource. Do not use removal-policy helpers that also alter `DeletionPolicy`. No new resources, deletion policy, image/source pins, properties, IAM, secrets, sizing, desired counts or application/runtime behavior change. These are shared Core/control/Temporal/frontend services, not the superseded per-run Fargate harness.

AWS defines the standard replacement policy and its separate cleanup obligations in [UpdateReplacePolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatereplacepolicy.html). No custom retention framework is needed. No code/resource is replaced or made unused by adding these five attributes; deletion evidence is therefore N/A.

## Sources of truth and supersession

Current STANDING-REQUIREMENTS sections 1–4 above are copied verbatim from the current handoff docs checkout 05bafdd98472a9032c1ec191d5e50fe447675239, including the current provenance update. PROCESS 6.1, current WORKFLOW and Root's bounded source allocation govern. The master extracts below are retained requirements only through item 0 and the approved AgentCore Runtime V1 migration. Historical planning-only, relay, activation-held, old pair/issuer, model proxy and budget-liability mechanisms do not override current authorization or return to scope. The existing full SDK, Core authority, durable receipts, schema compatibility and bounded forward rollback remain.

Master: docs/handover/20261022/source-of-truth/Capiro-Meri-Wiring-Closeout-Plan-20261021.md. Supersession: docs/handover/20261022/source-of-truth/SUPERSEDED-BY-ITEM-0.md.

#### MX-12 · Verify restart, retention, restore and forward rollback as one recovery story
**Priority / type:** P0 data/authority recovery before affected release.

**Evidence and root cause:** EX-04 rollback is a fresh forward render/deploy of prior image inputs, not UpdateService to an old revision, because revisions/material are pinned. MR distinguishes completed checkpoint continuity from in-flight historical cleanup. MM retention spans metadata and object bytes; MT command receipt/liability must survive loss of response. Source existence does not prove a restored database/object pair is coherent.

**Bounded work:** Use existing lifecycle journals/issuers/retention watermark and source/image ledger. Define scenario-specific expected durable facts and cleanup obligations for control restart, runner crash, Temporal outage, Core503, owner/proxy replacement, deploy mid-turn, stop during deploy, object-write/DB-commit loss, and restore from backup. MM owns purge/tombstone semantics; MT owns domain effect reconciliation; MR owns original/next-turn retirement. Release owner composes them into a bounded disposable-native rehearsal, then an approved live drill if required. Define operator RPO/RTO and retention restoration policy; do not invent a second event store or repair mutable history manually.

**Dependencies:** MR continuity and Stop gates; MX-04–07; external effects stay held until exact receipt/reconciliation passes.

**Acceptance:** Restoration never revives revoked grants, deleted memory/artifact content or spent/UNKNOWN budget as available; no duplicate task/mail/provider effect after restart. A prior compatible checkpoint resumes only under current authority; incompatible runtime versions refuse without persistence. Forward rollback retains current schema compatibility, prior image evidence and existing conversation liabilities. Backups/restore/deletion of product data require separate approval.

#### MX-14 · Make release scope and operator actions explicit, bounded and reversible
**Priority / type:** P0 release authority; owner decision and separately approved execution.

**Evidence and root cause:** Historical plans distinguish first authenticated chat, integrated preview and desktop full product; source receiver descriptions retain explicit holds. The present user request is planning only. Main/PR merges, source tests, an old shipping instruction or a generated packet do not authorize this task to activate capabilities.

**Bounded work:** Owner chooses the concrete release profile from MX-03 and the accepted definition of done. Root owns Meri/Core/frontend shipping and final integration under Neo's current authorization. Prepare one dated change packet naming source/image/feature/migration/cost/tenant/provider/audience, exact steps/observation windows, stop/rollback conditions, accountable operator and sanitized evidence. Separate low-risk source assembly from native test setup, provider-live calls, migrations/grants, PKI/credentials/OAuth, image publication, stack/service/listener/DNS changes and actual task/mail/notification effects.

**Dependencies:** All affected P0 tickets, selected P1 flow closures, MX-08–13 acceptance.

**Acceptance:** No shipping step proceeds on a generic “all source integrated” claim. Each required action has its own valid authorization and verified outcome; unknown submission is observed before retry. Unsupported/optional/post-launch items remain visibly open rather than counted as wired. Production promotion or replacement of a retained legacy fallback requires an explicit scope decision and rollback proof. No such action occurred in this audit.

### Matching scenarios (verbatim)

| ID | Scenario | Required outcome |
| --- | --- | --- |
| E09 | Image-only release after completed turn | Existing conversation and pending reserved successor continue under candidate11-compatible rules |
| E42 | **[RE-SCOPED]** Forward rollback and schema compatibility | Previous image redeployed through new valid material/revisions; retained receipts and liabilities remain valid |

### Applicable scenario supersession (verbatim)

| Item | Disposition | Retained requirement |
| --- | --- | --- |
| E09 image-only release after a completed turn | KEEP | The conversation continues after a deploy |
| **E42** forward rollback and schema compatibility | **RE-SCOPED** | Drop "retained liabilities"; keep forward rollback and receipts |

## Proportionate validation and evidence

Before product edits, use the existing private owner bindings for offline baseline renders. Render the changed generators with exactly the same bindings and dependency runtime; parse the frontend YAML with CloudFormation intrinsic tags preserved. Compare the entire semantic templates. Required delta: exactly `/Resources/<named resource>/UpdateReplacePolicy`, absent to `Retain`, at the five resources above. All other values, logical resources and properties must remain equal, including unchanged `DeletionPolicy`. Core companion stack templates must be unchanged. Keep full private bindings/templates in owner-only scratch; publish paths, hashes and scrubbed delta proof only. Never invent binding values or public fixture IDs.

Reuse Release's private `corrective-rollout/execution-retention-v3` records and `rollback-retention-v3` lifecycle templates as evidence for the installed five policies (Core task14; control70, worker66, schedule3; frontend31) and Core forward `actualReplaceAndRetain`. Reference existing owner evidence by name, not copied secret material. This offline source proof does not assert a new deployment or live acceptance.

Planned checks: offline baseline/candidate synthesis, YAML semantic comparison, exact five-path assertion, changed-source whitespace/status and source provenance. Report commands, UTC, exits, hashes and any failures in the existing Integration handoff. Independent narrow review remains Supporting-owned. Tests not run: application builds, broad suites, browser/provider/DB/cloud gates, new image builds or deployments. These have no changed application behavior and are not this lane's qualification. No new executable repository tests or mirror tests; mutation N/A. The finite offline comparison is evidence, not a new test framework.

Done means each repository has a committed/pushed draft PR with exact base/head/tree, its named source path and this identical brief, plus a successful whole-template delta proof. Root alone may merge after independent review. Source-only pins must be reported separately from the unchanged qualified application-image pins; these changes do not require relabeling or rebuilding those images. Preserve active checkouts and reusable caches. Integration owns only its local scratch and does not clean Release inputs or retained physical resources.


## Completed source qualification — 25 October 2026 UTC

Offline baseline render at 19:37:56Z and candidate render at 19:38:09Z both exited 0 with Node 24.22.1, CDK 2.273.0, TypeScript 5.9.3 and js-yaml 4.3.2. They used identical existing private binding bytes and the same reusable dependency cache. Core produced three stacks. Full semantic comparison at 19:39:10Z passed: exactly the five absent-to-Retain attribute paths above, zero other changed values, unchanged Core companion stacks and unchanged DeletionPolicy throughout. Source whitespace checks passed in all three repositories.

Commands from Integration's owned checkout: `node work/retention-alignment/render.cjs baseline`, `node work/retention-alignment/render.cjs candidate`, `python work/retention-alignment/compare.py`, and `git diff --check` per repository. Both render commands used NODE_PATH pointing to the existing complete cache `C:/dev/wave2-r-agentcore-runtime/node_modules`; Meri's owned checkout links to that same cache. Evidence is `work/retention-alignment/{baseline-render.json,candidate-render.json,semantic-proof.json}`. Full templates remain private; the handoff contains their hashes and exact diff paths.

Preserved diagnostics: the first baseline attempt exited 1 because the initially selected cache lacked `@aws-sdk/client-ecs`; no source change fixed that environment issue. After selecting the existing complete cache, baseline/candidate passed. The first evidence comparison exited 1 because it treated Release's numeric installed-attribute count as a boolean; the reader was corrected to compare the actual count with the expected resource count, and all five installed policies/revisions verified. No product assertion or source was weakened. Candidate CDK validation emitted four W3011 warnings, one per CDK task, because replacement-only retention does not add DeletionPolicy; those warnings remain unsuppressed and match the exact requested scope. The YAML comparison is parsing/semantic validation, not a cloud validation claim.

Existing lifecycle evidence confirms all five installed policies on the allocated old revisions, with no new task revision, service/deployment change or physical-resource change during that lifecycle-only phase. The retained Core forward plan records actual retention verified. Independent narrow review is pending Supporting; Root owns merges. No application build, broad suite, cloud/provider/database/browser gate, image rebuild or apply ran. No executable repository tests were added; mutation N/A. These source pins are separate from unchanged qualified application-image pins.
