# Capiro remaining execution and deployment plan

Prepared 17 October 2026; bounded status snapshot through the reported N2/foundation update and Neo's 14:21 UTC product correction. Whole-app plan for Neo, dot, Fable, and a receiving engineer with no prior conversation context.

## 1 Outcome and boundaries

Finish the rebuilt desktop Capiro application across these three repositories:

- [capiro-frontend](https://github.com/neo-capiro/capiro-frontend): the unified Portfolio, Modules, Settings, shared shell, and integrated Meri interface.
- [capiro-backend](https://github.com/neo-capiro/capiro-backend): production-derived Core, its required data and action contracts, Objective and Strategy integration, shared deployment routing, and a verified backend-only cleanup.
- [meri-greenfield](https://github.com/neo-capiro/meri-greenfield): the independently implemented Claude Agent SDK runtime, governed data and actions, durable conversations, artifacts, schedules, browser/Bash execution, and Meri product services.

Preserve [capirov2](https://github.com/neo-capiro/capirov2) and the existing production application throughout. Do not treat a preview deployment as production cutover permission. The target is an organized, maintainable app with no verified-dead code left behind, without deleting active consumers, deployment inputs, migration history, or recovery evidence.

The canonical maintenance location is capiro-backend branch dot/app-remaining-deployment-plan-20261017, path docs/deployment/CAPIRO-REMAINING-DEPLOYMENT-PLAN-20261017.md, initially based on PR78 bcdd689956e1aff3fa316103e75ec60ebe024fda. This is the single coordinating plan for remaining work. The other repositories link to it rather than maintaining full copied plans. Pinned technical documents remain evidence and detailed contracts. Record subsequent changes in this plan's baseline and coverage ledger; do not create competing replacement backlogs. Implementation details stay in their owning repository.

### Latest product correction for Engagement and Meetings

Neo's 17 October 14:20–14:21 UTC instructions supersede broader Engagement designs: Modules holds **Outreach**, matching the functional baseline of current live Engagement at os.capiro.ai. **Meetings belongs in Portfolio inside the client profile**, retaining the existing profile/calendar meeting-modal flow, preparation, notes, and debrief behavior.

Remove Reports and all unrequested extra Engagement tabs. This is scoped to the Engagement/Modules surface; it does not authorize removing every report feature across the app. Inspect the live Engagement UI read-only before deciding the exact retained tab/control set. Do not invent richer recommendations, new Plan functions, or extra navigation as requirements. Remove obsolete routes/components/imports/styles/tests/fixtures that exist solely for removed tabs, and verify no dead code is left. Preserve shared Outreach and Portfolio Meetings consumers, actual backend workflows, and intentional deep-link redirects/migration.

### Three delivery milestones

1. **First authenticated chat:** deploy a coherent, bounded preview and prove real sign-in, selected-client scope, native Core admission, first prompt/stream, saved history/reload, second prompt, Stop, and next prompt. Unrelated full-product work must not delay this milestone.
2. **Complete desktop v1:** finish every accepted frontend/Core feature and Meri requirement, then qualify the coherent release against the original functional, security, visual, artifact, retention, recovery, quality, performance, and cost gates.
3. **Four advanced features:** browser takeover, individually authorized authenticated website workflows, full Office editing, and a device/browser bridge. Prepare contracts independently, but implement/enable in the agreed later sequence after the first shipment and complete-v1 priority. Their appearance in designs does not expand current permissions.

Desktop is the active acceptance scope. Mobile is explicitly deferred. Preserve the original responsive requirements in the scope ledger as deferred work, rather than claiming mobile acceptance or quietly deleting it. Other viewport requirements require an explicit scope classification before release.

### Non-negotiable interpretation

- Source acceptance, local tests, image qualification, deployed health, and authenticated live acceptance are different states.
- Existing authorized routine code work, inspection, focused tests, and review continue without new administrative approval loops.
- This plan grants no cloud, credential, database, security, spending, publishing, or destructive-action authority.
- Existing access denials remain in force. Do not repackage or indirectly publish a denied payload.
- Named application IDs, resource ARNs, migration hashes, exact commands, targets, and credentials must come from current verified evidence. A blank is a blocker for that step, not an invitation to invent a value.
- Preserve the original 96 selected Meri capabilities, 43 exclusions, and 14 named skills. First-chat success does not reduce v1 scope.
- No completion percentages or delivery-date claims are implied by this plan.

## 2 Evidence baseline and freshness

Read this section before choosing a branch or claiming a task complete. Evidence is immutable and pin-specific; current PR descriptions can lag their heads.

### Source register

| Item | Baseline and evidence | Meaning |
| --- | --- | --- |
| Frontend product receiving | [PR86](https://github.com/neo-capiro/capiro-frontend/pull/86), de587eec44f2dc45565bfbe8bd4a10bb0d301fde | Combined reviewed non-Meri desktop work and Meri first-chat guard; source only |
| Frontend configuration | PR79, separate from PR86 | Obtain its current exact head and diff before receiving; flags stay default-off until serving dependencies qualify |
| Frontend first-chat acceptance | [Exact checklist](https://github.com/neo-capiro/capiro-frontend/blob/de587eec44f2dc45565bfbe8bd4a10bb0d301fde/docs/non-meri-continuation-20261016/DOT-LIVE-ACCEPTANCE-20261017.md) | Nine real authenticated steps, still outstanding |
| Frontend missing design decisions | [Neo design requests](https://github.com/neo-capiro/capiro-frontend/blob/de587eec44f2dc45565bfbe8bd4a10bb0d301fde/docs/figma-34-audit-20261016/NEO-DESIGN-REQUESTS.md) | Design/data/contract gaps must be distinguished from code defects |
| Core first-chat image source | PR48, 6542f5b089656b6d255465edd464d06c2a0b408f | Qualified older first-chat source; no claim it includes later GET, cleanup, or Objective work |
| Core shipping/routing lineage | [PR78](https://github.com/neo-capiro/capiro-backend/pull/78), bcdd689956e1aff3fa316103e75ec60ebe024fda | Current source-only shared-listener proposal; dependent Core GET/guard changes remain separate |
| Core cleanup inventory | [Backend-only inventory](https://github.com/neo-capiro/capiro-backend/blob/1b232adc3f40fdefba327caee4e5ef1eb6ef365d/docs/backend-cleanup/20261017/BACKEND-ONLY-INVENTORY.md) | Cleanup branch diverges from shipping and Objective; an existing task is receiving seven reviewed cleanup commits onto PR78 lineage |
| Objective integration | [Integration index](https://github.com/neo-capiro/capiro-backend/blob/e5c8f920ace2625e17e9c182c567184d38520c79/docs/objective-strategy-core-20261017/INTEGRATION-INDEX.md) | Reviewed Core PR73 cohort, source-compatible but execution held |
| Meri original release contract | [Deployment plan](https://github.com/neo-capiro/meri-greenfield/blob/f4a93b50bdbadcda0f89e4b9eca09f6aad958315/docs/plans/MERI-DEPLOYMENT.md), [capability scope](https://github.com/neo-capiro/meri-greenfield/blob/f4a93b50bdbadcda0f89e4b9eca09f6aad958315/docs/CAPABILITY-SCOPE.md) | Full v1 functional and quantitative release requirements |
| Meri receiving | [PR133](https://github.com/neo-capiro/meri-greenfield/pull/133), latest observed head db8a16334b40b6d2be9207a4b71046fb798f15c6 at 14:13:32 UTC | Original inspected head f4a93b50 is superseded; receiving branch fable/meri-first-chat-receiving-20261017 |
| Current Meri shipping backlog | [Backlog at db8a1633](https://github.com/neo-capiro/meri-greenfield/blob/db8a16334b40b6d2be9207a4b71046fb798f15c6/docs/shipping/20261017/BACKLOG.md) | Identifies Stages 2–6 gaps; newer foundation result below supersedes its source-not-started wording |
| Current first-chat change set | [Change set at db8a1633](https://github.com/neo-capiro/meri-greenfield/blob/db8a16334b40b6d2be9207a4b71046fb798f15c6/docs/shipping/20261017/FIRST-CHAT-CHANGE-SET.md) | Proposal, partly stale image/cost rows; reconcile before execution |
| Newer N2/foundation result | [Stage result](https://github.com/neo-capiro/meri-greenfield/pull/121#issuecomment-6234957592) | N2 success, snapshot available, and 79-resource foundation CREATE_COMPLETE reported; read back before next operation |
| Newer B5/N2 evidence | [Shipping result](https://github.com/neo-capiro/meri-greenfield/pull/121#issuecomment-6234839531), [N2 receiving evidence](https://github.com/neo-capiro/meri-greenfield/pull/121#issuecomment-6234799397) | Supersedes older B4/current-image rows |

### What is actually established

**Frontend:** exact PR86 frozen install, TypeScript, production build, standalone dependency closure, and smoke passed locally. Focused Meri host tests passed 6/6; architecture tests 7/7. Broad architecture exited 1 with **226 unchanged size findings**, zero blocking findings on integration-changed paths. These are not 226 newly discovered functional bugs. Confirm the actual release pipeline's treatment and record disposition; do not suppress findings or weaken thresholds. If existing policy allows baseline-aware acceptance, do not turn unrelated size refactors into an invented first-chat blocker. Full v1 must retain an accountable architecture cleanup/disposition plan.

There is no qualified PR86 image or deployment evidence. Earlier PR81 pushed an image and a later scan was clean, but its build FAILED at scan-read IAM; this is not a qualified replacement. Do not transfer PR81 image evidence to PR86 or automatically retry a paid build.

**Core:** image sha256:722a483259ebb5e9162b9294c26895bafa890fcfee45dc927ff1d2ec35fa071b is qualified for source 6542f5b089656b6d255465edd464d06c2a0b408f, with 40 static and 44 runtime checks and zero scan findings. Private health/startup passed; last standing service state was desired/running/pending 0/0/0. No authenticated public proof. Its receipt migration is already part of the recorded setup and must not be rerun casually. Later GET routing and product integrations require their own exact candidate qualification.

**Cleanup:** focused local evidence reports 111 tests across 16 builds and 23 typechecks for its own candidate. The active task receiving seven reviewed cleanup commits onto shipping lineage owns that integration. Do not duplicate it. Historical PR39 deletion counts do not describe the present branch.

**Meri images:** the old Node image sha256:6617b23650cc8cce973beac90c13f7c8231ccf3fbab4d4b4c44b26aea35c180c was qualified. B4 proxy sha256:0f60986be72a6d90340e8994f54cad18ffde91db7510ad73598dec865fc73b80 was qualified for pre-D1 source ab590d9fc520f858921a0b1cb01c293867f798cd, build 4e4c7888-55be-4d5f-9bb2-532837939d07. Neither is the final D1 pair.

B5 proxy **qualified** at 14:03:32 UTC: build 40c3dab2-bf77-426c-a219-1fd80c37956f; product sha256:38f299b5d8c4b51aee7f659a28fbda06d91f10d0c9736cfaf8bc6596d18be805; scan COMPLETE with no findings; real installed-native startup smoke passed. Source d375d43d, with proxy bytes unchanged at receiving commit 588bd87edc7351f5e7f121f53614e779fc9f01e6. B5 supersedes B4. Record the full d375d43d source SHA from the build receipt before execution.

N2 Node build afb7f8ac-5af4-4a13-8931-c5de60de8f31 is now **reported SUCCEEDED**, with zero scan findings and digest sha256:05b81710d7b526bb738ae8ff3df29b520668c958f8386ad77854f9e945ee23fa. It uses 588bd87edc7351f5e7f121f53614e779fc9f01e6, including D1 and PR134 second-turn/Stop corrections. Archive SHA256 4e46db4f9f35cfc2b1c7241cf9f3c2e6b6ee636fec059c80b482fab42bd2e23c. The receiving operator reads the exact terminal receipt/native qualification evidence before deployment. The Temporal derivative image remains a separate outstanding build.

The Debian assembly image with nine HIGH findings is **builder-only, recorded, never deployable**. Product-image approval does not turn it into a runtime.

**Newer foundation progress:** Fable reports Stage 0 snapshot meri-first-chat-pre-20261017 AVAILABLE and Stage 2 foundation CREATE_COMPLETE with 79 resources. Renderer first-chat-foundation.mjs at db8a1633 has 5/5 focused tests; outputs are recorded in infra/product-preview/first-chat/foundation-outputs.json. Reported resources include Aurora SG5432 ingress from the new Meri marker, unattached meri-preview-control-8080 target group, meri.internal Cloud Map, control SG allowing only ALB→8080, and empty secret containers. No shared listener, Core SG, or DNS change is reported. Verify actual outputs/state before the next dependent operation; do not rebuild already completed foundation work.

**Product serving and full authenticated chat remain unproven.** Foundation creation does not mean Stage 1 SQL, Stage 3 services, private activation, or public first-chat acceptance is complete.

### D1 and spending reconciliation

The newer Meri source records owner approval of 65,536 input and 8,192 output tokens, no thinking, USD 2/run and USD 25/day. The previous 8,192-input/256-output envelope rejects the SDK's own prompt and must not be deployed as the intended first-chat envelope. Current SQL design uses a **non-resetting USD 25 cap row**; it does not implement automatic daily reset. A later day requires a reviewed cap update or a separately qualified reset design.

Root's directly verified total remains USD 600. The earlier USD 363 was reservation accounting, not invoiced spend. Fable subsequently reports USD 371 reserved after B5/N2, still not an invoice. Reconcile build IDs, allocations, actual observed usage, and remaining commitments before new root-owned paid work. A relayed report that another session's budget was lifted does not automatically change root's authority. Fable can act under valid authority in its own session; all action-specific security/credential requirements still apply.

The earlier two-hour/USD 5 smoke is a proposal, not paid approval or a reliable current cost estimate. Re-cost the actual rendered task sizes and include model, build, standing-resource, storage, and teardown exposure.

### Required freshness procedure

At startup, before receiving a lane, before sealing a build, and immediately before a live change:

1. Read current PR heads, exact parent/tree, open review holds, and relevant PR121 updates.
2. Compare them to this register. Record old and new SHA, changed owned paths, and effect on evidence.
3. Confirm repository instructions and actual environment/tool availability.
4. Read the current cloud state for the specific operation; do not use a source snapshot as live truth.
5. Preserve still-valid evidence. Rerun only invalidated checks, plus the final coherent release gates.
6. Stop only the dependent action if identity, source, permission, resource shape, or outcome is uncertain. Continue independent source work.

## 3 Ownership and parallel execution

dot owns whole-app coordination, non-Meri frontend, Core, cleanup, shared integration, and final authenticated E2E. Fable owns Meri implementation/integration, image qualification, and Meri shipping. The shared listener, Core activation, and capiro.ai DNS remain dot-coordinated resources.

There must be **one active AWS mutation operator at a time**, with a written handoff of account, region, resource scope, exact stage, rollback, and observed state. Fable is the default Meri AWS shipping operator; dot is the designated shared-listener/Core/DNS operator when that stage is validly authorized. This is a serialized ownership boundary, not permission for both to modify the listener. Implementation workers perform no paid builds, live SQL, IAM/security, credential, listener, DNS, or service writes.

### Receiving rules for every agent

- Read this plan, the owning repository instructions, the current lane record, and the relevant pinned contracts before editing.
- Claim one concrete outcome and file set. Use a separate branch or worktree. Do not work in another lane's active checkout.
- Inspect existing implementation and completed PR85/86 work before adding anything; prefer completing or correcting the existing path.
- Do not broaden scope, add a second orchestration loop, duplicate DTO frameworks, or invent APIs from Figma.
- Shared contracts, migrations, lockfiles, frontend shared modules, and infrastructure have one editor at a time. Coordinate exact paths and change before editing through [PR121](https://github.com/neo-capiro/meri-greenfield/pull/121) and the owning repository PR.
- Reserve migration identifiers centrally. Do not renumber historical/applied migrations to make a branch merge.
- Record exact source, tests actually run, expected versus observed outcome, unrun environment-dependent checks, exclusions, and next dependency.
- If an unchanged deterministic test fails, retain its evidence and diagnose its cause. Do not repeatedly rerun it or rename it a pass.
- Submit a narrow commit and reviewable handoff. No unreviewed cross-lane cherry-picks or force-updates.
- Receiving owner verifies ancestry/content, review status, and combined affected contracts before integration. Evidence counts cannot be summed across overlapping suites or transferred to unrelated SHAs.
- Continue independent lanes while a live stage is blocked. Use supported capacity and bounded concurrency; host memory exhaustion is a real blocker, not a reason to mark paused work complete.

### Status vocabulary

Use one evidence state per capability or deployment object:

| State | Required meaning |
| --- | --- |
| inventory | Existing implementation, gaps, or consumer reachability not yet established |
| source | Code exists at an exact commit; only stated local/focused evidence applies |
| integrated | Received onto the chosen coherent branch with combined affected checks passing |
| qualified | Exact real image/native runtime/database/SDK path exercised with retained evidence |
| deployed | Exact qualified assets are running in the intended environment under valid authority |
| live-verified | Real authenticated user exercised the intended end-to-end flow |
| blocked | Attach the current evidence state plus exact missing dependency/action/owner |
| deferred | Explicit approved scope disposition; not hidden unfinished v1 work |

“Ready,” “done,” and “green” are insufficient without the state, pin, and gate.

## 4 Coverage ledger and deliverables

Maintain one whole-app ledger next to this plan, with filtered views in each repository. Each row contains:

- Stable requirement ID, capability/control/source family, and original scope source.
- Milestone: first-chat, desktop-v1, or explicitly deferred advanced/mobile.
- Repository, owner, branch, exact source SHA, and consumer/provider dependencies.
- Current evidence state; concrete remaining implementation; design decision if any.
- Acceptance case IDs, source/runtime/image/live evidence links, and exact failed/unrun checks.
- Migration/config/credential/network dependencies; approval reference only when relevant.
- Release disposition and rollback/disable path.

Start with every selected capability in Appendix A, every excluded row in Appendix B, all 14 skills in Appendix C, all accepted frontend controls/design states, Core contracts, retention classes, and all gates in Sections 9–10. Do not equate the 82 read-implementation inventory with all 96 selected capabilities or with 14 skills.

Every lane delivers a commit/PR, updated ledger rows, focused evidence, a short unresolved-dependency list, and a receiving brief. Each coherent release delivers:

1. Source and dependency manifest for all three repositories.
2. Scope/coverage and design-control ledger with no unexplained omissions.
3. Image receipts, source archives/hashes, immutable digests, scans, and actual startup evidence.
4. Rendered infrastructure diff, exact migration SQL/hashes/order, config and secret references/versions without values.
5. Dependency/approval and cost/reservation register.
6. Deployment, readback, rollback, and cleanup receipts.
7. First-chat or full-v1 acceptance report, explicitly named.
8. Known limitations and disabled/deferred features visible to operators and users.

## 5 Parallel implementation lanes

### Lane F1 Shared shell and first-chat frontend

Owner: dot; Fable owns Meri runtime contracts.

- [ ] Retain PR86 as the reviewed product base unless a newer receiving commit is explicitly chosen.
- [ ] Receive separate PR79 configuration only after verifying exact diff, defaults, host pins, allowlists, and environment variables.
- [ ] Keep Portfolio/Modules/Meri navigation and selected-client identity coherent across the unified shell.
- [ ] Preserve archived-client refusal before Core bootstrap or Meri session issuance.
- [ ] Complete the selected-client server gateway against a genuinely qualified narrow Core GET target. Never fall back to production Core when preview reads are held.
- [ ] Preserve durable request ID before the first bootstrap POST, exact six-field receipt validation, and retry/reload identity.
- [ ] Seal and qualify the exact frontend image; do not reuse earlier PR81 evidence as approval.
- [ ] Execute Section 8's nine-step live acceptance only after the deployed dependencies qualify.

Deliverable: coherent frontend source/config pair, immutable image, sanitized browser and backend correlation evidence, and per-step first-chat result.

### Lane F2 Portfolio and supporting data

Owner: dot; Neo owns unresolved design decisions.

- [ ] Reconcile already implemented PR85/86 fixes before choosing new code.
- [ ] Complete truthful client/Portfolio data aggregates, supported numeric evidence, and authorized resource links.
- [ ] Separate missing source data from zero values, especially funding, fiscal-year obligations, facility type, LODES aggregation, and geographic attribution.
- [ ] Finish Objective intake and human association interactions using accepted server authority, not browser-invented link permission.
- [ ] Preserve the ten-category location profile; add whole-load failure/retry, partial sections, revoked permission, removed/moved location, stale/conflicting evidence, units/effective periods, import review, rejected rows, and unknown-save recovery.
- [ ] Complete Government/Federal loading, denied, no-match, partial-source, stale/conflicting states; keep program context separate from attributable awards.
- [ ] Close Research create/edit/cancel/validation/empty states and Calendar New Event API ownership where still unresolved; do not invent backend behavior from controls.
- [ ] Keep Planner/Strategy governed paths default-off until Lane C2 authority and custody qualify.
- [ ] Map all desktop controls and applicable Figma states to real API/local behavior and focused fixtures.

Design decisions: blank five-field Objective form; direct/inherited associations and remove/conflict/unknown outcome; multiple-project Planner copy without unsupported one-project/30-day limit; location states/evidence; Government states; visible-modal enter/exit/close and reduced-motion binding. Use the exact nodes in the design-request source.

Deliverable: completed Portfolio/data contract integration, source-quality matrix, remaining Neo decisions, desktop parity evidence.

### Lane F3 Modules and Settings

Owner: dot; provider/Core owners supply real contracts.

- [ ] Inspect current live os.capiro.ai Engagement read-only and freeze the exact Outreach functional baseline.
- [ ] Make Modules hold Outreach; remove Reports and unrequested extra Engagement tabs under Neo's latest instruction. Do not treat older multi-tab designs or new Plan/recommendation concepts as required scope.
- [ ] Keep Meetings inside the Portfolio client profile with existing profile/calendar meeting-modal preparation, notes, and debrief flows; migrate any obsolete deep links intentionally.
- [ ] Remove exclusively obsolete tab routes/components/imports/styles/tests/fixtures and dead code, while preserving shared Outreach/Portfolio Meetings consumers and genuine backend workflows.
- [ ] Finish provider wiring and selected-client/current-authority handling for accepted Modules flows.
- [ ] Complete loading, empty, partial, error, denied, stale, recovery, and success states with truthful availability.
- [ ] Resolve Newsletter initial canvas semantics before changing fields or inventing a new editor engine.
- [ ] Add a real Template Studio loading affordance and honest freshness in denied Strategy states.
- [ ] Complete Settings reads/writes for accepted controls with exact save/error/conflict behavior; align Meri-owned settings with Lane M5.
- [ ] Verify shared tokens, keyboard/focus/dialog behavior, long content, reduced motion, and desktop navigation.
- [ ] Retain only genuine disabled placeholders; no button should pretend a backend workflow succeeded.

Deliverable: Modules/Settings coverage matrix, provider bindings, relevant Neo design decisions, and final desktop visual/control evidence.

### Lane C1 Core first-chat and governed reads

Owner: dot.

- [ ] Preserve production-derived native identity/current membership/client authorization and the already qualified bootstrap contract.
- [ ] Finish qualified selected-client GET support for /api/me, /api/clients, and /api/clients/<id> behind the reviewed narrow routing boundary.
- [ ] Reconcile Core guard priority 3-to-4 and bounded GET priority 3 through their CloudFormation-owned procedure, separately from manual shared-rule moves.
- [ ] Do not claim existing first-chat image includes new GET/source changes. Seal a new exact candidate if needed, with contract/migration compatibility.
- [ ] Complete read handlers required by the Meri selected source inventory, including actual restricted roles, source semantics, filters, counts, pagination/history, freshness, partial coverage, and denied states.
- [ ] Prove native current actor/tenant/client against actual authority; browser hints and Clerk subject alone are not the Core actor.
- [ ] Preserve explicit production/preview route isolation and denied writes.

Deliverable: Core serving and read-target manifest, exact auth/contract checks, migrations/readback, selected source-family readiness.

### Lane C2 Objective to Strategy to Planner

Owners: dot for Core/frontend contracts and native authority; Fable for Meri issuance/custody/readback.

- [ ] Start from the final integration index, not superseded raw-capture findings. Core PR73 includes the required original raw HTTP capture.
- [ ] Preserve one action router, v2 initial-Strategy selection, CAS/exact receipts, source-version distinctions, current access checks, and server-owned continuation after browser closure.
- [ ] Finish genuine Core admission/base authority, retained-access/native bindings, purpose-qualified credentials, and actual database privilege/RLS/trigger verification.
- [ ] Fable finishes Objective Ed25519 issuer, genuine protected-facts issuance/readback, accepted-job custody, durable replay, completion capture, and reader mounting.
- [ ] Close known custody gaps: uncertain-claim stickiness, final cleanup cancellation/deadline check, adapter tests, and native PostgreSQL qualification. Reserved meri_objective_source.custody is not an applied migration.
- [ ] Keep Core decision RS256, Objective reader-v2 Ed25519, and Temporal RS256 protocols/keys distinct.
- [ ] Verify the seven Core Objective migrations and actual shared Strategy migration history; source paths with future-looking date names are identifiers, not proof of execution dates.
- [ ] Receive the exact reviewed Meri/Core/frontend cohort before enabling any governed operations.
- [ ] Keep OBJECTIVE_PLANNER_CONTINUATION_ENABLED, OBJECTIVE_STRATEGY_INTAKE_ENABLED, governedPlannerReadEnabled, and governedStrategyIntakeEnabled closed until their authority, consent, and serving gates pass.
- [ ] Add human association authoring and any governed commands/confirm-pair UI only under their accepted contracts; read/open panels do not establish write authority.
- [ ] Prove long-running work survives browser close and all current/requested/applied output states remain truthful.

Deliverable: qualified coherent Objective cohort, authority/custody evidence, migrations and source-version matrix, flag activation decision, desktop end-to-end outcome.

### Lane C3 Backend cleanup and organization

Owner: dot. Use the existing active seven-commit integration task.

- [ ] Receive its result onto the PR78 shipping lineage; inspect exact first-parent diff and reconcile separately with Objective lineage.
- [ ] Produce an entrypoint-to-consumer map spanning runtime imports/providers, Docker contexts, scripts, CI, infra, deployment commands, migrations, licensing, and evidence retention.
- [ ] Remove regenerable outputs only with retained inputs, reproducibility evidence, and recovery.
- [ ] Move frontend, marketing, and onboarding build/deploy consumers to their real replacement before deleting old trees.
- [ ] Keep Onboard SPA and raw legacy Meri consumers until their active consumers are migrated or retired with proof.
- [ ] Treat the defense API runtime-source mirror as deliberate until parity/build references are resolved.
- [ ] Consolidate duplicate documentation/scripts and clearly separate active runbooks from historical evidence, without erasing audit/recovery inputs.
- [ ] Preserve schemas/migrations, THIRD_PARTY_NOTICES, runbooks, RDS CA/deployment evidence, and any retained data until consumer/retention review allows removal.
- [ ] Produce final before/after tree metrics from committed Git trees. Do not use sparse-working-tree sizes or old PR39 totals as final proof.
- [ ] Leave one clear organization for backend apps, shared contracts, infra, tests, migration history, and operator documentation.

Deliverable: integrated cleanup PR, retained/deleted consumer ledger, regeneration/restore instructions, exact tree metrics, and no active frontend/legacy consumer silently broken. Broad cleanup is not a prerequisite to first chat unless it affects that candidate.

### Lane M1 Runtime images and first shipment

Owner: Fable; coordinate C1/F1 and the single AWS operator.

- [ ] Receive and independently verify the reported successful N2 terminal receipt/digest; retain N2/B5 as the D1 candidate pair.
- [ ] Build and qualify the Temporal derivative under valid spending authority.
- [ ] Complete the exact Stages 2–6 source gaps in Section 7 before requesting or executing those stages.
- [ ] Pin component/runtime/model/proxy/SDK/Temporal versions and compatible workflow/checkpoint formats.
- [ ] Prove real native SDK startup, trusted proxy, discovery where used, streaming, budget enforcement, installed dependencies, Linux/non-root behavior, and service identity.
- [ ] Deploy only the coherent first-chat cohort; return the complete release packet to dot.
- [ ] After bounded acceptance, reconcile task, run, budget, journal, Temporal, and ECS state to no unexplained UNKNOWN or leaked paid resources.

Deliverable: qualified images, exact rendered change set, approved-stage record, live serving receipt, and cleanup report.

### Lane M2 Read tools and 14 skills

Owner: Fable; dot supplies Core/data adapters.

- [ ] Reconcile PR125 accepted source and PR132 HOLD_TESTS without re-publishing the denied scope-ledger blob.
- [ ] Inventory all 82 read-adapter rows: current source record is 69 complete, 3 partial, 10 absent; installed/qualified/live counts remain zero in the inspected backlog.
- [ ] Close partial/absent adapters; then qualify all accepted source semantics against real authorized fixtures.
- [ ] Preserve one typed catalog for schemas, handlers, discovery, auth metadata, UI labels, and benchmark mapping.
- [ ] Separate candidate search, exact query/count/status, full evidence read, and coverage; no arbitrary SQL or generic unrestricted data escape hatch.
- [ ] Bind subject/client/portfolio/mailbox scope and normalized dates/FY/version at the server. Recheck permission at execution and stored-content access.
- [ ] Implement/qualify all 14 original skills with stable ID/version, executable evidence/completion manifests, scope and budget rules. Keep ordinary questions lightweight.
- [ ] Preserve Commitments & Deliverables evidence, unknown owners/dates, promises versus suggestions, deduplication, delivery proof, mapped monday.com scope, and explicit incomplete coverage.
- [ ] Qualify native deferred tool discovery through the real trusted proxy. A documented bounded fallback requires measured evidence; do not restore the old lexical engine silently.
- [ ] Keep optional Decisions/JEV disabled or shadow until their independent adoption gates pass.

Deliverable: complete capability/skill ledger, adapter fixtures, actual-proxy discovery evidence, and benchmark-ready gold cases.

### Lane M3 Governed write intents

Owner: Fable; dot owns Core mutation contracts.

- [ ] Inventory existing source and receive only the reviewed implementation.
- [ ] Complete immutable proposals, exact scope/target/data binding, approval expiry, current-authority recheck, denial/revocation, execution, durable receipt, and replay.
- [ ] Limit initial source mutations to the accepted memory proposals, tasks, and artifact filing semantics. A selected legacy name does not authorize broader source writes.
- [ ] Separate application-local artifact/schedule actions from Capiro source mutations.
- [ ] Prove repeated delivery, uncertain responses, worker death, and delayed approvals produce zero duplicate mutations and truthful UNKNOWN/recovery states.
- [ ] Keep excluded send_email/reply_email and broader mutations excluded.

Deliverable: command contract and approval matrix, durable outcome fixtures, integration evidence for each selected command.

### Lane M4 Conversation lifecycle and durable execution

Owner: Fable.

- [ ] Preserve received PR134 changes at 588bd87e: Stop terminal fencing/definitive Temporal NOT_FOUND, cancel re-read instead of duplicate write, and unsettled next-turn 409/NOT_DISPATCHED.
- [ ] Complete history/paging/transcript, reconnect, stop, steer, retry, pause/resume, fork, continuation, lost-response recovery, and terminal transitions.
- [ ] Verify one active writer, durable original-run binding, lease/fencing, session plus workspace restoration, and no duplicate turn or publication.
- [ ] Prove browser close does not unintentionally cancel server-owned durable work.
- [ ] Qualify Linux/real PostgreSQL/Temporal paths previously unrun or host-failing; do not label Windows-only fixtures native runtime qualification.
- [ ] Preserve source/version compatibility across reconnect, resume, fork, and deployment.

Deliverable: lifecycle state matrix, Linux/PG/Temporal evidence, interruption/recovery traces, and completed UI-control contracts.

### Lane M5 Memory tasks settings schedules and budgets

Owner: Fable; dot supplies canonical Core boundaries.

- [ ] Reconcile PR131 HOLD, PR128 accepted source, and occurrence source 5aa13719.
- [ ] Fix the actual routine flow failure currently 0/2 with HTTP 502 SCHEDULE_TOOL_FAILED.
- [ ] Resolve the denied Core memory parser publication and denied preference PostgreSQL retry through the legitimate blocker/authorization path; do not repackage or bypass.
- [ ] Complete memory read/propose/review boundaries, canonical provenance, task semantics, preference/settings persistence and conflict/recovery.
- [ ] Complete Temporal schedule create/list/inspect/update/pause/cancel/history, timezone/DST, retry policy, owner/scope, budget, and reauthorization per occurrence.
- [ ] Enforce model grants and D1 run/preview caps outside the agent; record usage for failed, cancelled, retried, and subagent work.
- [ ] Reconcile any daily-budget behavior with the current non-resetting cap row before claiming reset functionality.

Deliverable: real schedule/routine evidence, governed memory/task/settings matrix, budget and occurrence accounting.

### Lane M6 Artifacts documents and analysis

Owner: Fable; dot coordinates shared filing/UI contracts.

- [ ] Inventory generation and version paths before adding new engines.
- [ ] Complete DOCX/PDF, spreadsheet, PowerPoint, HTML/code, and analysis workflows with adopted libraries.
- [ ] Close application-admission gaps that still omit PowerPoint/analysis.
- [ ] Preserve original files; revisions create immutable versions with provenance, checksums, exact-version previews/downloads and current authorization.
- [ ] Complete extraction/upload failures, rendering, preview, version switch, natural-language revision, cancellation/recovery, and approved filing receipts.
- [ ] Verify native files open, supported formulas/reference totals are correct, and rendered pages/slides contain no critical clipping/corruption.
- [ ] Reserve artifact migration IDs centrally; qualify real storage and rendering dependencies.
- [ ] Treat full Office WYSIWYG editing as an advanced feature, not implied by v1 read-only previews.

Deliverable: artifact/version schema, rendering qualification, native benchmark files and human-quality evidence, filing receipts.

### Lane M7 Objective integration

Owner: Fable; paired with C2.

- [ ] Receive reviewed-held PR129 and related PR127/123 only through C2's frozen compatibility contract.
- [ ] Complete genuine issuer/custody/replay/readback and native database proof.
- [ ] Maintain exact source/version authority and server-owned completion.
- [ ] Return one reviewed coherent receiving SHA, not a collection of individually tested branches.
- [ ] Keep execution held until Core authority, database, credentials, serving, and UI gates are satisfied.

Deliverable: the Meri half of C2's qualified end-to-end cohort.

### Lane M8 Browser Bash and isolation

Owner: Fable.

- [ ] Treat existing browser/Bash evidence as offline-only until installed native execution qualifies.
- [ ] Qualify the supported Playwright/browser build and non-root sandbox in the actual worker image.
- [ ] Prove destination/egress controls at network/proxy boundaries, not just prompts or hooks.
- [ ] Bind files, downloads/uploads, browser profiles and cookies to the authorized conversation; enforce current access, revocation, cancellation, and cleanup.
- [ ] Keep worker task capabilities short-lived and scoped; workers receive no Core DB login, administrator credentials, raw model account key, or Temporal service credentials.
- [ ] Prove untrusted uploaded configuration cannot become runtime instructions/configuration.
- [ ] Qualify public browsing and approved Bash operations before separately qualifying authenticated websites.

Deliverable: native sandbox/egress/permission evidence and enabled workflow matrix.

### Lane M9 Four advanced features

Owner: Fable; Neo supplies unresolved feature-specific decisions.

- [ ] Prepare bounded contracts and dependency lists without taking over first-chat/v1 critical work.
- [ ] Browser takeover: explicit handoff, ownership, resume, cancellation, and audit.
- [ ] Authenticated website workflows: named sites/actions, trusted credential custody, current authority, side-effect approvals, restart/isolation/revocation.
- [ ] Office editing: chosen editor/library/license, original preservation, version/concurrency semantics, supported-format fidelity.
- [ ] Device/browser bridge: exact device scope, connection identity, user approval, local/cloud boundary, revocation and audit.
- [ ] Enable each only after its own acceptance and authority are established.

Deliverable: four separate scoped implementation/qualification packets and later live acceptance, without claiming broad current parity.

### Lane Q Whole-app release verification

Owner: dot, with an independent reviewer; Fable supplies Meri evidence.

- [ ] Maintain the unified ledger and exact release manifests.
- [ ] Build the real-request dataset: current manifest has zero real requests; start with 75 real requests and expand to at least 200 labelled cases.
- [ ] Establish at least 60 representative real E2E tasks and scoring rubric before evaluating.
- [ ] Complete desktop Figma/control/manual accessibility coverage.
- [ ] Complete tenant/within-tenant isolation and measured revocation.
- [ ] Complete retention/deletion and restored-backup safety across all data classes.
- [ ] Run 10-concurrent-run performance/cost qualification and operational recovery drills on the coherent release.
- [ ] Issue separate first-chat and desktop-v1 decisions. Neither source counts nor health checks substitute for these.

Deliverable: release evidence pack and exact pass/fail/blocked decision.

## 6 Integration and merge order

Branches can progress in parallel; receiving follows dependencies.

1. Freeze shared contracts and the current source register. Receive the active cleanup shipping-lineage work independently after review, without replacing newer shipping/routing or Objective commits. Cleanup is not on the first-chat critical path unless its exact changes are required for that runtime candidate.
2. Complete the minimum first-chat cohort: Core bootstrap/native identity plus narrow GET read capability, Meri D1/N2/B5/Temporal runtime, and frontend PR86.
3. Receive the separate PR79 configuration default-off. Verify preview host/allowlist/auth/read pins before enabling it.
4. Run combined affected contract checks, then one coherent build/architecture/security pass and immutable image qualification.
5. Deploy foundations and count-zero services, establish deny routing, privately activate and verify native membership/bootstrap/admission, then activate the bounded public preview and run first-chat acceptance.
6. In parallel, receive non-Meri product/data improvements, remaining Meri v1 lanes, and the verified cleanup changes in dependency-sized batches.
7. Receive the Objective/Strategy/Planner coherent cohort separately after genuine authority/custody qualifies. It is not a hidden first-chat dependency.
8. Freeze the desktop-v1 source/config/migration/contract cohort, run broad final qualification, deploy the same assets, and perform final authenticated whole-app acceptance.
9. Prepare production cutover as its own explicit change with legacy fallback retained. No source merge automatically authorizes it.
10. Progress the four advanced features only within their accepted sequence and scope. Mobile remains deferred pending a new explicit user instruction; do not begin it automatically after another milestone.

Do not merge divergent cleanup or Objective branches wholesale into a shipping candidate without ancestry/content review. A cherry-pick that changes runtime bytes invalidates the affected image evidence even if all source tests were green on its original branch.

## 7 Exact deployment preparation and stage execution

### Target and current technical gaps

The proposal places separate Meri services in the existing capiro-dev cluster, account 967807252336, us-east-1, existing VPC and Aurora. It does not create a new VPC or replace production. Before any write, verify actual account/region/cluster/VPC/subnets/DB/listener/zone and the current resource inventory through approved read access.

The backlog originally marked Stage 2 source not started and Stage 3 partial. **The newer N2/foundation report supersedes that status:** Stage 0 snapshot and the 79-resource foundation are reported complete. The remaining stage composition still needs verification against actual outputs. Fable must:

1. Receive first-chat-foundation.mjs and its exact output manifest; compare the deployed 79 resources against the intended KMS/IAM/security/Cloud Map/log/secret/S3/target-group inventory. Identify only genuine remaining deltas. Complete issuer/owner and other count-zero service composition without recreating completed resources.
2. Correct temporal-binding.mjs and temporal-network-readback.mjs, which currently reject the real shared endpoint SG by requiring five distinct endpoint SGs.
3. Reconcile model-proxy-template.mjs: remove the unapproved internal NLB/duplicate S3 gateway endpoint assumptions, use the accepted Cloud Map path, and match proxy UID 10001.
4. Produce executable grants SQL; the inspected file is comments only.
5. Qualify the Temporal server image.
6. Re-cost actual Temporal roles: renderer uses 1 vCPU/2 GiB and history 2/4, rather than the old 0.5/1 table.
7. Supersede contradictory own-VPC/internal-ALB/capiro-dev-refusal documents with one accurate current operator source.
8. Record directly valid authority for D4 CA/credential creation and D5/D6 network choices. Broad urgency or a relayed quote is not an action-specific security grant.

### Stage packet required before dependent execution

Fable returns one exact Stages 2–6 request with:

- Rendered source SHA and file hashes; account/region/resources and old/new shapes.
- Every role/action/resource/condition, trust policy, credential/KMS/secret operation, security rule, shared-resource delta, and material-init source.
- Images, task definitions, UID, CPU/memory, ports, health/readiness, discovery names, count-zero initial state, and connection paths.
- Database SQL and migration order/hash, owners/grants/RLS effects, backups and recovery.
- Revised costs, bounded active window, hard caps, stop criteria, and teardown.
- The named sole operator for each stage and exact authority evidence.
- Checks before/after each write, stop-on-drift/uncertain-outcome rules, and safe rollback.
- Clear shared Stage 4 request to dot, and later Stage 6 request only after private success.

It is valid to bundle foreseeable confirmations into one exact reviewable packet. Do not add extra approvals for routine source work, and do not infer sensitive-action approval merely from approval of this document.

### Stage 0 Backup

- [ ] Confirm current shared Aurora ownership and snapshot policy.
- [ ] Read back the reported AVAILABLE meri-first-chat-pre-20261017 snapshot and retain its receipt; do not create a duplicate merely because this checklist was written earlier.
- [ ] Record restore implications for the shared database. No whole-cluster restore is automatically authorized.

### Stage 1 Database

- [ ] Review exact executable SQL before running a dedicated one-shot migrator; never migrate at service startup.
- [ ] Reconcile applied history, identities, grants and schema ownership first.
- [ ] Intended Meri schemas: meri_conversations, meri_product_budget, meri_service_identity.
- [ ] Proposed conversation sequence: 0001–0011, 0013, 0015, 0016, 0017; 0012/0014 remain held unless a newer reviewed change explicitly replaces that hold.
- [ ] Budget migrations 0001_product_budget and 0002_tenant_budgets; D1 seed cap 25,000,000 microUSD with non-reset semantics.
- [ ] Service registration migration and Temporal/visibility stores use the exact reviewed versions/hashes.
- [ ] New runtime roles receive no Core/public broad grants, BYPASSRLS, or superuser.
- [ ] Preserve Core tables and existing receipt migration.
- [ ] Read back objects, privileges and migration receipts.
- [ ] Schema/role removal is a separately considered destructive rollback once data exists; prefer fencing and forward repair. Do not automatically drop saved conversations or restore a shared cluster.

### Stage 2 Security and network

The foundation is reported CREATE_COMPLETE; reconcile its outputs and remaining deltas instead of starting from zero. Empty secret containers do not prove material configuration or credential custody is complete.

- [ ] Read back completed foundation resources first and apply only genuine remaining reviewed deltas under the required action-time authority; do not recreate existing resources.
- [ ] Maintain least-privilege KMS signing, per-role IAM, scoped secrets, and exact-version custody.
- [ ] Public ALB reaches control 8080; private readiness/control is 8082.
- [ ] Review exact issuer 8445, Temporal 7233, runner-to-control 8082, runner-to-proxy 8443, proxy-to-owner 8444 and allowed Aurora 5432 peers.
- [ ] D6 NAT TCP443 egress, if approved, is limited to issuer/control/owner groups; it is not general worker internet authority.
- [ ] Reuse actual endpoint security groups without broadening them implicitly.
- [ ] Read back every shared SG/bucket/KMS change. Counts remain zero.

### Stage 3 Count-zero services

- [ ] Register immutable digest-pinned task definitions and create control, Temporal worker/issuer, proxy, owner, and five Temporal roles at desired count zero.
- [ ] Runner is a task definition, not a permanently running service.
- [ ] Verify material-init success gates, read-only root, non-root UID, deliberate writable paths, no public IP, and secret-reference versions.
- [ ] Reuse and read back the existing foundation target group meri-preview-control-8080 with /health/live health checks; do not recreate it. Public liveness must not disclose private readiness. Create the control service without load-balancer association for private activation unless an exact alternative anchor has been reviewed and approved; attach it only through the qualified Stage 6 sequence.
- [ ] Preserve count-zero deployment until D1–D6, N2/B5/Temporal image, SQL and security gates pass.

### Stage 4 Shared host denial and Core routing

dot coordinates one operator, fresh readback, and exact action authority. [PR78 operator procedure](https://github.com/neo-capiro/capiro-backend/blob/bcdd689956e1aff3fa316103e75ec60ebe024fda/docs/core-meri-shared-listener-reconciliation-20261017.md) is the controlling source.

- [ ] Verify exact listener, physical rule ARNs, conditions/actions/targets, vacancy at priority16, and current manual-rule ownership.
- [ ] Freeze other priority allocations.
- [ ] Relocate existing physical rules in this exact order: 9→16, 8→9, 7→8, 6→7.
- [ ] After each move, read back the entire listener; same ARN/conditions/action/target, no duplicate priority, next destination vacant.
- [ ] Create one retained exact host-only meri-preview.capiro.ai rule at priority6, fixed JSON404 for all methods/paths.
- [ ] Verify its physical ARN and denied-host matrix, including encoded/normalized paths and preview-header overlap.
- [ ] Preserve production API rules10–15, ordinary callbacks at5, marketing/Web VNext/default behavior.
- [ ] Treat Core guard3→4 and GET3 as their separate CloudFormation-owned sequence; do not manually move that guard.

Priority6 is required because hostless engagement/Recall rules would preempt a lower-priority Meri rule. Do not assume that no DNS means no traffic: explicit Host requests still reach the ALB.

### Stage 5 Private activation

Only after the deny is established and valid activation/cost authority exists:

- [ ] Start reviewed Temporal roles, issuer, owner/proxy, then control/worker and the qualified Core target in dependency order.
- [ ] Keep exactly one control instance until process-local poststart nonce behavior is qualified for another topology.
- [ ] Validate private readiness for each tier, actual native bearer identity/context, and one real first prompt through the private path.
- [ ] Read budgets, run/task/custody/Temporal state and receipt correlations; health alone is insufficient.
- [ ] Keep public Meri rule6 denying while testing privately.
- [ ] On failure or approved-window expiry, fence admissions, settle/cancel safely, return new services/Core to their documented stopped state, and reconcile until no unexplained UNKNOWN.

### Stage 6 Public target binding and DNS

This stage remains a separate exact request after private gates pass.

ECS requires a listener-associated target group before attaching the service. Choose and review one real solution:

- An additional anchor rule needs an approved priority and proven isolation. A host such as meri-preview-anchor.invalid is **not literally never-matching**; an explicit Host request can reach it. Do not accept “invalid DNS” as a security boundary.
- Same-change forward/attach avoids an additional priority but can expose registering targets for a health-check window. Record the risk and precise sequence before execution.

Then:

- [ ] Verify same Meri rule6 ARN/priority/exact host; change only its approved action to the reviewed Meri control target.
- [ ] Attach the exact service/target binding, wait for healthy targets, and execute positive/negative route probes.
- [ ] Publish the exact Route53 alias only under its valid authority; verify certificate/host routing.
- [ ] Activate the frontend exact image/config/flags after qualified Core GET/bootstrap and Meri serving are established.
- [ ] Run Section8 acceptance with the designated Test Clerk application and authorized internal client.

### Rollback and containment

For a public Meri failure, change rule6 back to fixed JSON404 first and read back the same physical ARN/action. Then fence new work, drain or deliberately cancel/checkpoint, stop targets/services, and remove DNS under the appropriate authority. Retain the rule6 denial while the host can reach the ALB. Removing it can route explicit-Host/cached-DNS traffic to production /api/*.

Routine rollback leaves moved manual rules at7,8,9,16. Full topology reversal after Meri rule6 exists needs a reviewed replacement isolation boundary. Core rollback removes GET3 through its service stack before moving its retained guard4→3.

Restore application images/config independently of database migrations. Preserve required old workers and checkpoint/workflow compatibility for in-flight runs. Never automatically reverse a migration by deleting new user data. Immediate security containment may cancel work; otherwise verify durable persistence before terminating an active worker.

## 8 First authenticated chat acceptance

Owner: dot, after independently reading back Fable's exact deployed release packet. Use the designated Test Clerk setup and a permitted internal tenant/client; no production-bound fallback.

Capture sanitized case ID, UTC time, route/status, request correlation, scope equality/mismatch, and result. Keep tokens, cookies, raw prompts/output, secret values, and real tenant/actor/client identifiers out of Git.

1. **Entry and sign-in:** approved HTTPS preview /healthz returns200, intended Portfolio entry renders, sign-in/post-sign-in complete without asset or console failures. Health is process proof only.
2. **Native selected client:** qualified narrow server-side GET resolves the permitted selected client. Current account tenant and native Core actor match bootstrap authority. Core actor is current.user.id, not merely the Clerk subject.
3. **New conversation:** /meri without conversationId; bootstrap query empty; Core returns HTTP200 with strict schemaVersion, requestId, conversationId, tenantId, actorId, clientId. Scoped requestId persists before POST.
4. **Meri admission:** session binds exactly to Core conversation/client; Meri independently verifies native identity and required context reads/revisions plus durable original-run and writer binding.
5. **First prompt:** native submit/events produce ordered stream and terminal completion with one user turn and no duplicate request.
6. **History and reload:** history/transcript persist; reload/reconnect and deliberately lost first-response retry reuse the same request and conversation. Prior turn appears exactly once.
7. **Second prompt:** next-turn within the same conversation completes; both turns remain saved without cross-client exposure.
8. **Stop and next prompt:** cancel acknowledges the selected active run; next prompt is accepted and completes without replaying stopped text or duplicate dispatch.
9. **Denied scope and client switch:** wrong client/conversation/account, origin, query/body, and allowlist paths fail closed. Check native unauthenticated401, invalid400, wrong-origin403, held-write503 where specified; inaccessible resources may403/404. Switching client during pending work cancels obsolete UI/bootstrap requests, clears the old displayed scope, and displays no old conversation. It must not silently cancel server-owned durable work; stopping that work uses its explicit authorized cancellation flow.

Pass only when all nine pass against the same deployed cohort and denial boundaries remain intact. Report partial results by step and pin. This milestone does not claim full v1, all tool families, Objective execution, mobile parity, or broad benchmark acceptance.

## 9 Efficient testing policy

The user wants implementation progress with minimal intermediate testing and broad tests at coherent release boundaries. Apply this policy without weakening safety-critical checks.

### While editing a bounded change

Run the affected unit/contract tests, scoped type/syntax checks, and a targeted browser case when UI behavior changes. Compare any known baseline failure by exact test and environment. Do not run whole-repository builds, broad E2E, all screenshots, or expensive image builds after each small commit.

Mandatory affected checks cannot wait until the end when a change touches:

- Authentication, tenancy/client walls, authority, revocation, origin/allowlists, or credential handling.
- Migrations, privileges/RLS, destructive cleanup, data preservation, or idempotency.
- Approval binding, duplicate side effects, worker fencing, cancel/recovery, or budget enforcement.
- Routing, sandbox/egress, material-init, image provenance, source/receipt identity, or security-sensitive configuration.

These are narrow change-specific checks, not permission to repeatedly run every broad suite.

### At receiving and coherent milestones

- Review exact diff/ancestry and run combined affected contracts once on the receiving tree.
- Run one combined clean install/build/typecheck, broad applicable desktop/architecture/security suite on the coherent candidate.
- Qualify each actual shipping image with its required provenance/scan/native startup gates.
- After deployed health and dependencies pass, run one broad authenticated acceptance for that milestone.
- Fix failures; rerun the affected regression set. Before release, rerun every required gate invalidated by the changes, plus the final required coherent checks.
- Do not transfer results from an older source/image, count skipped or unrun tests as pass, or suppress deterministic failures to reach a green summary.
- A host/environment failure is classified and moved to the correct native gate; it remains unproven until that gate runs.
- Do not repeatedly rerun unchanged failing commands or spend on identical failed builds. Diagnose, make the authorized fix, and use a valid approved retry/new-build path.

First-chat gets its bounded safety/runtime/live gates. The complete desktop-v1 candidate gets the full original release suite below. Do not require the 200-case benchmark before the first benign chat; do not call a first-chat smoke complete v1.

## 10 Complete desktop v1 release gates

All applicable requirements need evidence against the immutable staging candidate. Freeze task sets, labels, denominators, rubrics, and performance cohorts before scoring. No worker may lower a target to mark its lane complete.

### Functional and source coverage

- [ ] At least60 representative real end-to-end tasks; at least 90% successful completion and at least 95% checked factual correctness.
- [ ] Begin reliability corpus with 75 real requests and expand to at least 200 labelled cases. A synthetic harness with zero real requests does not meet this.
- [ ] Every selected 96 capability independently implemented and behavior/policy qualified; all 43 exclusions documented.
- [ ] All 14 named skills retain identity/version, required evidence, scope, completion and approval contracts.
- [ ] 100% agreed source inventory authorized, with exact counts/aggregates, paging/history, full evidence and honest freshness/coverage.
- [ ] Portfolio, Modules, Settings and shared shell accepted controls wired to real behavior; Objective/Strategy/Planner accepted cohort works with server-owned continuation.
- [ ] Conversation lifecycle, attachments, approval/rejection, citations, exact-version artifact operations, filing, and schedules work end to end.
- [ ] Browser/Bash enabled workflows are individually qualified; no implicit claim of advanced authenticated-browser parity.

### Security and data authority

- [ ] Zero unauthorized rows/citations/transcripts/browser state/files across at least 100 adversarial cross-tenant cases.
- [ ] 100% within-tenant fixtures pass for client walls, mailbox ownership, private memory, grant expiry, role changes and stored-context revocation.
- [ ] Agree a numeric revocation bound before read qualification; source target is at most 30 seconds, subject to the recorded accepted bound.
- [ ] Measure live cancellation, further publication denial and access to historical threads/files/previews/artifacts against that bound.
- [ ] Worker/network/task capability/secret isolation and denied-route probes pass on the actual environment.
- [ ] Zero duplicate mutations after retries/repeated delivery/worker death; current authority rechecked at execution.
- [ ] Security findings have explicit disposition under the actual release policy; no silent scan/architecture waiver.

### Native artifacts and desktop visual quality

- [ ] 100% benchmark native files open; supported formulas and reference totals correct.
- [ ] At least 95% meet the agreed human-quality rubric; zero critical clipping/corruption; originals preserved.
- [ ] 100% distinct visible accepted controls have mapped behavior and passing checks; disabled controls cannot execute.
- [ ] 100% pinned Figma frames/overlays/states classified and mapped to implementation/fixture or explicit scope deferral.
- [ ] Run the 11 named Meri Figma walkthroughs as real service-backed review paths; screenshot navigation alone is not behavior proof.
- [ ] Review accepted desktop light/dark viewports with fixed fonts/data/clock/dynamic masking and recorded intentional differences.
- [ ] Zero critical clipping, overlaps, unreadable content or missing actions.
- [ ] Keyboard, accessible names, visible focus, dialog focus/return, contrast, long content/scrolling, and reduced motion pass manual and automated checks.
- [ ] Maintain explicit mobile deferral; do not claim phone/tablet acceptance from desktop screenshots.

### Durability operations performance and cost

- [ ] 100% restart/retry suite passes; recovery within two minutes on healthy infrastructure.
- [ ] Browser closure, worker loss, approval wait, stop/retry/fork and stale proposal recovery preserve scope and exactly-once outcomes.
- [ ] At 10 concurrent runs: p95 UI acknowledgement at most 2 seconds and p95 fresh-task readiness at most 90 seconds.
- [ ] Measure warm lookup and any stricter original ordinary-answer cohorts separately; never count an unfinished streamed token as a finished answer.
- [ ] Enforced per-run/tenant budgets, concurrency/runtime limits, and measured usage for 100% of runs/attempts, including failures/cancellation/retries/subagents.
- [ ] Provider usage reconciles with broker/gateway records; no unexplained allocations or paid tasks remain.
- [ ] Exact staging candidate, alerting, restore, rollback and in-flight workflow/checkpoint compatibility drills pass.
- [ ] Every generic subsystem has pinned adoption/version/license evidence; custom replacement has a demonstrated limitation.

### Retention and restored backup safety

Startup retention fencing/reconciliation already exists and must be preserved. Do not revive superseded findings. Purge remains disabled and data-class coverage incomplete; that is not release acceptance.

- [ ] Complete a class/store/owner/retention/deletion/backup/restore matrix for transcripts, UI events, uploads, browser profiles/cookies, workspace/checkpoint snapshots, previews, artifact versions, telemetry, local intents/settings, schedules and external canonical memory.
- [ ] Distinguish local deletion from external-source mutation; do not infer permission to erase canonical external memory.
- [ ] Test purge candidates, fences, retries, partial failure, tombstones, authorization caches and recovery before enabling deletion.
- [ ] Reconcile Object Lock/backup expiry with the promised retention policy; locked data cannot be claimed immediately purged.
- [ ] Test restored backups cannot re-expose deleted or revoked material.
- [ ] Verify all applicable data-class fixtures and operational runbooks before full-v1 release.
- [ ] Any permanent deletion uses the required action-time authority; test preparation does not authorize live purge.

### Reliability gates preserved from the original plan

| Gate | Required result |
| --- | --- |
| RG01 | Accepted source/tool route on at least 95% of frozen held-out cases, including expected clarification |
| RG02 | 100% deterministic subject/window/FY/version fixtures |
| RG03 | Evidence Recall@10 at least 95% on labelled frozen retrieval units with no more than 10 gold records; report denominators/source slices |
| RG04 | 100% deterministic count/status/comparison fixtures |
| RG05 | Zero false absence claims when coverage is partial, unavailable, or stale |
| RG06 | 100% selected skill ID/version/evidence/completion fixtures, including replay/steer/reconnect/resume/fork |
| RG07 | Zero unauthorized disclosure or mutation |
| RG08 | Actual-proxy native discovery and adversarial catalog recall, including reference/header/stream/compaction/resume and execution-time auth |
| RG09 | Frozen warm simple-lookup answer p95 at most 15 seconds; optional-router incremental p95 at most 500 ms and total regression at most 10%; retain any stricter original cohort |
| RG10 | Only if optional classifier promoted: at least 25% relative held-out routing-error reduction, adequate power/confidence intervals, no material coverage/argument regression |
| RG11 | Only if optional JEV promoted: pre-frozen task-specific evidence-quality improvement, calibrated abstention and no required-evidence loss |
| RG12 | Replay/reconnect/revocation/full-evidence/completeness contract suite passes |

The original ordinary-answer p95 at most 8 seconds, if retained in the accepted companion cohort, is not replaced by RG09's broader 15-second ceiling. Optional classifier/JEV failures keep those services disabled/shadow and do not block a passing qualified SDK baseline.

### Release decision

G0 discovery and scope, G1 real runtime/component qualification, G2 isolated development, G3 authorized reads, G4 execution workspace, G5 selected commands, G6 immutable staging qualification, and G7 controlled internal/tenant release remain distinct gates.

Start controlled rollout with the accepted Capiro-internal pilot and verified Neo identity/current membership; canonical IDs and client grants must be read, not guessed. Preserve the old application until separately authorized cutover. Each exposure increase uses the exact candidate, allowlist, flags, measured quality/latency/cost, rollback and authority.

## 11 Current blockers and immediate next actions

### Start now without duplicating existing work

1. Fable receives N2 success, reconciles completed foundation outputs, and finishes the remaining Stages 1 and 3–6 SQL/Temporal/service/material-configuration/cost work.
2. dot receives the already active cleanup-on-shipping result, reviews current frontend/config/read-path dependencies, and prepares the fresh shared-listener packet.
3. Fable resumes independent Meri lanes on supported capacity, reporting active versus memory/host-blocked lanes truthfully.
4. dot and Fable complete genuine Core GET/native admission and Meri custody dependencies in their owning lanes.
5. Neo supplies missing desktop design decisions; independent coding/data work continues.
6. QA freezes coverage, real-request collection and final rubrics while implementation proceeds.

### Decisions or authority that must not be fabricated

- Exact N2 qualification receipt and completed foundation output/state readback; the reported digest is recorded above.
- Remaining exact service/stage renderers, grants SQL, Temporal image, material configuration, current costs and active-window cap; do not recreate completed foundation resources.
- Directly valid sensitive-action authority in the execution session for credentials, security/network/IAM access and shared listener/DNS changes.
- Root budget changes beyond the directly verified USD 600, if any; reservations versus actual spend.
- Physical manual listener-rule ownership and fresh routing state.
- Target-group association strategy and any anchor rule's real isolation.
- Actual Test Clerk/native identities, permitted test client, migration history and privileges.
- Native Objective authority/custody and credential purpose separation.
- Remaining design states, data aggregates/provider APIs and Calendar New Event behavior.
- Complete retention-class policy and measured revocation bound.
- Legitimate resolution of existing denied publication/PG actions.

A blocker freezes only the dependent work. The plan itself is not a request to stop unrelated authorized implementation.

## 12 Handoff template for a context-free agent

Task: [one concrete outcome]
Milestone and requirement IDs: [first-chat / desktop-v1 / explicit advanced]
Repository, branch, base SHA and owned paths: [exact]
Read first: this plan, repository instructions, lane record, pinned contract/design source
Current evidence state: [inventory/source/integrated/qualified/deployed/live-verified]
Existing implementation to preserve: [PR/commit and behavior]
Remaining changes: [bounded checklist]
Dependencies and coordination owner: [provider/consumer and exact missing artifact]
Authority: routine source work within scope; identify any separately gated external action
Acceptance: affected local checks now; exact native/live/final gates later
Do not change: [shared files, migrations, production paths, denied payloads, unrelated features]
Return: exact commit/tree, diff summary, checks with observed results, evidence links, ledger update, blockers and next receiving action

The receiving owner acknowledges the exact commit and evidence state. No agent should need to infer scope from an old chat or an unqualified “all done” message.


## Appendix A The 96 selected legacy registry capabilities

These are accepted scope, not completed implementation claims. Each receives its own ledger row with original boundary, owner, exact commit, behavior/policy fixture and live qualification. Names such as save_memory retain the governed proposal boundary; a name does not grant broader canonical writes.

1. get_research_portfolio
2. get_research_portfolio_changes
3. get_research_evidence
4. read_chat_attachments
5. read_monday_client_boards
6. search_capiro_data
7. get_client_context
8. search_research_sources
9. run_analysis
10. search_client_knowledge
11. query_intelligence
12. query_knowledge_graph
13. search_memory
14. list_memory_proposals
15. search_congress_bills
16. get_bill_status
17. read_bill_text
18. get_certification_status
19. search_floor_votes
20. search_cbo_cost_estimates
21. resolve_entity
22. search_lda_filings
23. list_global_datasets
24. query_global_data
25. search_sec_filings
26. search_fara_registrations
27. search_federal_grants
28. search_federal_awards
29. search_gao_reports
30. search_state_bills
31. get_state_bill_status
32. search_state_floor_votes
33. get_state_legislator
34. get_committee_roster
35. get_representation
36. list_members
37. get_state_rule_status
38. search_intel_articles
39. search_committee_hearings
40. search_legiwatch_news
41. get_florida_budget_project
42. search_legislative_research
43. get_legal_reference
44. search_crs_reports
45. query_economic_data
46. get_district_nexus_context
47. get_district_nexus_changes
48. search_public_web
49. scrape_web_page
50. save_chat_attachments
51. list_emails
52. search_emails
53. get_email_thread
54. list_upcoming_meetings
55. save_memory
56. search_program_elements
57. get_program_element
58. get_pe_budget_timeline
59. get_pe_contractors
60. get_pe_bills
61. get_pe_report_language
62. search_acquisition_personnel
63. get_acquisition_person
64. create_word
65. create_excel
66. create_powerpoint
67. schedule_task
68. list_scheduled_tasks
69. cancel_scheduled_task
70. update_scheduled_task
71. query_tasks
72. query_action_items
73. search_tracked_bills
74. query_regulatory_dockets
75. search_sam_opportunities
76. query_debriefs
77. read_client_meetings
78. query_outreach
79. read_client_documents
80. lookup_client_registry
81. create_task
82. update_task
83. find_contacts
84. search_funding_opportunities
85. get_funding_opportunity_requirements
86. get_funding_opportunity
87. get_opportunity_client_context
88. get_opportunity_government_landscape
89. search_federal_contract_awards
90. search_federal_subawards
91. search_contract_vehicles
92. search_procurement_forecasts
93. get_business_development_context
94. get_business_development_evidence
95. get_business_development_recent_changes
96. get_district_federal_market

## Appendix B The 43 excluded or deferred registry capabilities

Keep these explicit in release notes. Selection of a related source read or named skill does not silently re-enable a deferred specialized operation. The latest Outreach/Reports navigation correction is an additional frontend scope change, not a rewrite of this Meri registry.

1. manage_research_portfolio
2. get_research_portfolio_analytics
3. create_research_portfolio_snapshot
4. request_research_portfolio_output
5. save_research_portfolio_output_to_client
6. watch_research_portfolio
7. update_research_portfolio_change_state
8. get_research_portfolio_bookmarks
9. create_research_portfolio_bookmark
10. get_research_portfolio_fit
11. get_research_portfolio_reviews
12. add_research_portfolio_review_note
13. get_research_portfolio_rules
14. get_research_portfolio_imports
15. get_research_portfolio_operations
16. prepare_research_portfolio_brief
17. prepare_research_portfolio_meeting
18. find_path_to
19. get_legiwatch_review
20. compare_florida_budget_amounts
21. prepare_legiwatch_briefing
22. compare_legislative_versions
23. save_legislative_research
24. preview_legiwatch_relevance
25. save_legiwatch_relevance
26. apply_legiwatch_suggestion
27. create_meeting_brief
28. draft_policy_memo
29. save_note
30. send_email
31. reply_email
32. confirm_memory
33. correct_memory
34. forget_memory
35. get_pe_buyer_workspace
36. create_client
37. update_client_profile
38. explain_opportunity_match
39. compare_funding_opportunities
40. build_opportunity_action_plan
41. get_business_development_brief
42. resolve_business_development_source
43. save_business_development_brief

## Appendix C The 14 required original skills

The [pinned legacy skill definitions](https://github.com/neo-capiro/capirov2/blob/fd8765ec01d292013758606204f2c9d886cd31c1/packages/shared/src/meri-skills.ts) supply intent references only. Implement new original skill content and executable manifests; do not import the old runtime/recipes. Every skill needs expected evidence/output rubrics, current authority, explicit scope/date/window, coverage limits, and completion fixtures.

1. research_company — Research a Company.
2. relationship_brief — Relationship Brief.
3. client_changes — Client Changes.
4. portfolio_changes — Portfolio Changes.
5. portfolio_overlap — Portfolio Overlap.
6. mail_history — Mail History.
7. meeting_prep — Meeting Prep Brief.
8. commitments_audit — Commitments & Deliverables.
9. funding_opportunity_match — Funding Opportunity Match.
10. pe_deep_dive — PE Deep Dive.
11. bill_watch — Bill Watch.
12. hearing_watch — Hearing Watch.
13. representation_lookup — Representation Lookup.
14. regulatory_docket_brief — Regulatory Docket Brief.

Required named-skill qualification does not override the 43 excluded specialized registry operations or invent current production parity. For example, funding matching needs an accepted new evidence/scoring rubric rather than silently treating the excluded legacy explanation/comparison/action-plan workflows as complete. Scope, data entitlements, evidence and current authority still control each executable operation.

