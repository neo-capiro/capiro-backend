# Meri File01 checkpoint — C0/C1 complete, C2 active

**October 5, 2026 — acceptance contract simplified (user-directed).** File01 acceptance now follows [01-Meri-Acceptance-Simplified-2026-10-05.md](01-Meri-Acceptance-Simplified-2026-10-05.md):

- Each case runs once through the ordinary product path as neo@capiro.ai in capiro-internal, on real clients. State-changing setup uses only the QA test client.
- Grading is automatic checks plus a pass/fail verdict from the user.
- No capture bindings, spend-journal events or per-case releases.
- The runner is `evals/meri/simple/run-cases.mjs`.

Batch 1 (memory and scope: 01, 05, 08–11) ran in about 25 minutes for roughly $6. All six answers completed and five passed the automatic checks; Case 10's second answer has no citations, so it is flagged. All six await the user's verdict, so accepted cases remain **0/75** and **0/7**. The finding below about governed captures is retained as history.

**October 5, 2026, 9:25 AM America/New_York checkpoint.** It answers five questions: what works, which commits prove it, what is deployed, what passed, and what blocks next.

- **What works now.**
  - A governed Case46 export can now reproduce the source document byte for byte. The served `MeriV3CleanAssistantService.prepareArtifactInput` no longer runs citation normalization on a governed capture export. That normalization ends in `trim()`, and it removed the source's final newline before the dispatch guard (generation-5 root cause).
  - A failed Case46 run can now be retired and retried without an API release. From generation five, the setup owner derives eligibility from retained state:
    - the deadline has passed;
    - every provider attempt is settled or rejected;
    - the run has one original prompt, at most one assistant message, and no proposal or artifact;
    - the four fixed retirements are unchanged.

    It then records the exact server-settled cost.
  - Earlier on October 5, generations 3–5 each failed for a different, now-fixed reason:
    - generation 3: the capture had no document read, and a blocked export aborted the turn;
    - generation 4: the executor refused the read, and a mismatch on the final newline was not explained;
    - generation 5: the trimming described above.

    Each failure is preserved with its settled cost: `c2-case46-gen3-outcome`, `-gen4-outcome`, `-gen5-outcome`.
- **Proof.**
  - [PR #1977](https://github.com/neo-capiro/capirov2/pull/1977) (orchestrator, main `e5ed6825f`): orchestrator source 1,579 passed, 2 known live skips; typecheck clean.
  - [PR #1978](https://github.com/neo-capiro/capirov2/pull/1978) (API, main `6663a4ce1`): 111 API Case46 tests passed (11 suites); typecheck clean.
  - [Release qualification](../releases/2026-10-05/c2-case46-generic-recovery-release/release-qualification.json): immutable images; API 34/34 and orchestrator 19/19 distinct packaged checks.
- **Deployed.** API549 (`6663a4ce1`, image `sha256:991d8dcd…`; rollback548 preserves API547) and orchestrator133 (`e5ed6825f`, image `sha256:4cf9ba19…`; rollback132 preserves orchestrator131) are promoted and verified; old tasks stopped, ALB targets healthy, `GIT_SHA`/`RELEASE_SHA` match source. Web390, nightly136 and the disabled broad projection worker are unchanged. The ordinary synthetic Pat identity and approved-memory reads passed, with the temporary session revoked. Earlier on October 5:
  - API545 and orchestrator129 (export-read);
  - API547 and orchestrator131 (write-only export).

  [Served readbacks](../releases/2026-10-05/c2-case46-generic-recovery-release/served/).
- **Acceptance is unchanged:** original **0/75**, CD **0/7**. No human rubric grades were inferred. File01 remains `01_BLOCKED`.
- **Spend.** The native journal is at event 49, with no active run. $44.71 is committed of $500, leaving $455.29.
  - Case46: $13.71 committed, **$1.29 left** of its $15.
  - Case12: $13.80 committed, **$1.20 left**.
- **Next blockers.**
  1. **Case46 is blocked on budget, not code.** The native per-case cap is hard-coded at $15. One gpt-6-astra Case46 call settles at about $0.95, and a successful export needs at least one call plus the approval. Generation 6 needs an explicit user amendment raising the Case46 per-case limit. With that, it can run on the deployed images with no further release, followed by the already-authorized Playwright approval/download/reload and human review.
  2. **Case12** has the same per-case exhaustion.
  3. **Case01 and Case20** have budget ($11.22 and $13.50 left), but their one-shot recovery authorities are consumed. Each needs a new operator chain: Case01 needs a re-bind of its existing fixture; Case20 needs a fresh controlled-read setup. They must run sequentially, because they share the tenant's single binding. The later Case14 receipt was still BLOCKED on clock and source-authority gates (`semantic_clock_api_tool_join_pending`, `source_client_authority_unproved`). So an offline receipt preflight must show those gates can close before any paid Case01 or Case20 capture.
  4. **Case14's approval must not repeat.**

**October 5, 2026, 1:41 AM America/New_York update:** API543 (`42811d70783636ad2c999ba6ddb8b3f58ee26e4f`, image `sha256:15e6ff6a2f04…`) is deployed and verified; rollback542 preserves API541. Orchestrator127, Web390, nightly136 and the disabled broad projection worker are unchanged; old API tasks stopped; ordinary synthetic Pat identity and 512-record memory reads passed with the temporary session revoked. [Release qualification](../releases/2026-10-05/c2-capture-budget-ledger-only-release/release-qualification.json), [served readback](../releases/2026-10-05/c2-capture-budget-ledger-only-release/served-readback.json).

**What changed (user-directed, 2026-10-05):** the per-capture provider cost ceiling is removed. Authenticated capture budgets (Case46 governed artifact, server read-only captures, synthetic reads) are now admitted `ledger_only` (PR #1964): every priced reservation and settlement is still recorded against the declared qualification figures, but dispatch is never refused on attempts, tokens or cost; the hard-coded $3/$15 caps and the receipt validator's cap are gone. Production research budgets remain `enforced`. The native spend journal ($500 aggregate, $15 per case) remains the approved-budget authority and is unchanged (journal40, $37.02 committed, $462.98 available, no active run). PR #1965 adds the exact generation-2 retained-history recovery for the second failed Case46 run (3a5b5609): it requires the generation-1 retirement record to remain present and fails closed on any changed history. Both failed Case46 runs keep their full $3 journal ceilings. This is a shared Meri change across tenants, not a tenant feature flag.

**Why the second Case46 run failed, exactly:** the orchestrator reserves the UTF-8 byte length of the whole provider request body as the input-token bound (1 byte = 1 token, about 3–4× real tokens) at $25/M, plus the Standard profile's fixed 16,384-token output allowance ($1.2288), so any live body over 70,848 bytes exceeded the $3 ceiling. The live body carried the client KB snapshot (≤4,800 chars) and real governed retrieval over four domains that the 65,374-byte offline fixture lacked. Neither service logged the rejected binding's byte count; no attempt row is written on rejection.

**Acceptance is unchanged:** original **0/75**, CD **0/7**; no human rubric grades were inferred. File01 remains `01_BLOCKED`. Next: refresh reviewed rates (6-hour validity, `prepare-reviewed-rates-c2-v5.mjs` pattern), generate the generation-2 Case46 recipe (fresh capture run id, proof `0d7ecf1e…`), run native plan → journal allocation/reservation → setup → single Standard turn → the already-authorized Playwright export/approval/download/reload flow once, then present the saved answer for human review.

Earlier checkpoints below are historical and superseded by this update.

**October 4, 2026, 11:50 PM America/New_York update:** API541 (`bf896b666dcdb33a3d603d10319235046039cadb`) and orchestrator127 (`11b669eb957f040fa6afd37bb8d61780ea5fdeb9`) are deployed and verified. All old tasks stopped; ordinary Pat identity and512memory reads passed. Web390, nightly136 and disabled broad projection remain unchanged. [Recovery outcome and source evidence](../releases/2026-10-04/c2-case46-recovery-outcome/outcome.json).

The fresh Case46 setup completed. A harness request carrying unsupported `reasoningMode` was rejectedHTTP400 before any message; authenticated readback provedREADY and0messages. The corrected original prompt reused the same reservation and created exactly one user message, then failed `research_provider_budget_cost_exhausted` before model dispatch. There is no proposal, assistant message or artifact. Playwright public sign-in preflight passed, but approval/download/reload remains **NOT RUN**. Do not replay either failed turn or setup.

Journal40 retains both failed Case46 ceilings and preserves history/native file identities: **$37.02 committed, $462.98 available, no active run**. Original acceptance remains **0/75**, CD **0/7**. An expanded offline test uses the full assistant pipeline and served create_word schema, but its synthetic Standard request reserves$2.86315 and does not reproduce the larger live failure. Exact live request sizing is required before another capture; no additional shared-context reduction is justified by this diagnostic alone. The user was informed that deployed context-size limits apply across tenants; recovery/capture controls are scoped, and Sol remains capiro-internal only.

Earlier checkpoints below are historical and superseded by this update.


**October 4, 2026, 10:57 PM America/New_York update:** API539 is deployed and verified (source `a2c5e7b915e8af2ab712303b2b7e5880a0de02c3`; PR1959 qualifies the image and PR1960 archives served evidence). The serialized steering bound, including provenance and citation bytes, is a shared Meri change across tenants, not a tenant feature flag. The user was explicitly informed of that scope. Sol remains enabled only for capiro-internal; customer/global model defaults are unchanged. Case12's failed retry retains its full $13.797053 ceiling. Case46's failed original turn was closed after its deadline in journal37, retaining its full $3 ceiling with no active run. Total committed remains $34.01, leaving $465.99. Full acceptance remains **0/75 original and 0/7 CD**.

The native Case46 audit found 512 steering records with only35,768 body characters. An offline regression reproduced479,638 serialized prompt bytes before remaining instructions/tools: metadata and citations bypassed the earlier body-only limit. The deployed fix bounds serialized steering evidence and discloses omissions;104focused tests, API typecheck,31packaged checks and served verification passed. PR1960 adds recovery restricted to the exact failed synthetic Case46 and an authenticated-capture provider pricing guard. Its API image passed32checks. Orchestrator qualification remains in progress: PR1961 corrected a test clock-order fixture; all1577source tests passed in the second build, which then failed an outdated test-name assertion. The third build requires the current readonly/artifact/none cases. No failed image was deployed. The user explicitly authorized Playwright; approval/download/reload awaits a real proposal from a new qualified run. Do not replay the old setup or submission. Current evidence: `C:/dev/main/outputs/meri-c2-20261003/STEERING-WIRE-CHECKPOINT.md` and its referenced output directories.

The older checkpoint below is retained as history; its served version, spend and Case46-not-run statements are superseded by this update.

**Current checkpoint, October 4, 2026, 8:38 PM America/New_York:** C0/C1 retain their recorded boundaries. C2 remains open, File01 is `01_BLOCKED`, and full acceptance remains **0/75 original cases and 0/7 CD cases**. No human rubric ratings were inferred.

**Served:** API535 now runs source `89402fd7cb60ef1e1a5c7cbb9e6a112a6defd544`, including the one-time Case12 remediation owner. Its 29 packaged probes and native task/image/source/configuration, ALB health, old-task retirement and ordinary Pat memory reads passed. Rollback534 preserves API533. Orchestrator125, Web390, nightly136 and disabled broad projection remain unchanged. [Live release evidence](../releases/2026-10-04/c2-case12-context-bound/served-readback.json).

**Scoped cheaper model:** capiro-internal (`17b63099-bc0f-4ac5-b596-496161e9481e`) now resolves its existing OpenAI credential to `gpt-6.1-sol`. Exactly one model-only POST201, masked readback, unique audit and native resolver verify the change. Key metadata and other provider rows are unchanged; customer/global defaults remain Astra. An initial audit time filter excluded the real database row because the local intent timestamp was later; read-only reconciliation resolved it without another write. The three-call compiled-client Sol sample passed grounding, forced function lookup and continuation, with conservative observed cost $0.004484. This is not served Meri or original-case acceptance. [Model verification](../releases/2026-10-04/c2-sol-release/tenant-model/verified.json), [probe](../releases/2026-10-04/c2-sol-release/probe/execution/result.json).

**Spend and current case:** native journal33 holds the Case12 retry's full $13.797053 ceiling: $31 committed, $469 available under the approved $500 cap. The prior $15.202947 known cost, $1 approval allocation and $1 model qualification allocation remain intact. The saved retry failed with `runtime_error`; the main model never dispatched because the internal reservation endpoint rejected its token bound. Six embedding attempts exist, four unresolved; 14 micros is a ledger charge, not final actual cost. Deadline is October4 8:59:35PM Eastern. Do not replay the retry or release its hold without source-bound reconciliation. [Failed saved turn](../releases/2026-10-04/c2-case12-context-bound/failed-turn.json).

**Current repair and next flow:** actual execution exposed an unbounded compatibility steering path: the compiler strips `tokenBudget`, and Meri had no legacy `charBudget`. Both Meri context requests now set48,000characters, retaining explicit omissions. All94 focused context tests and API typecheck pass; the regression uses512rows with real off/shadow compilers and compares the previous over500,000character result. Deployment of this new fix is pending. Case46 native plan/cost preflight remain valid historical evidence; setup/export are not run. Hermes is stopped at user request; no callable Dot interface was found. Work continues directly. Prior Case12 fixture setup and original failed-run history remain intact.

**CD browser slice:** sign-in is complete. In the served capiro-internal workspace, the named Commitments & Deliverables card rejected general-scope execution, inserted its starter after client selection, and allowed editing before submission. The unsent draft was cleared and general scope restored. An authenticated API533 catalog read confirmed permanent `commitments_audit`, `requiresClient: true`, general/client launch scopes and `readOnly: true`; the temporary API session was revoked. This was an admin launcher check with zero submitted turns, not ordinary-role or full CD acceptance. Evidence is under `C:/dev/main/outputs/meri-c2-20261003/cd-ui-launcher-root-v1/`; the next-flow checkpoint and Case46 cost preflight remain in the same output root pending the next versioned release packet. Case14 approval must not repeat; Case17's source/reload slice and Case01/20 failures remain partial/historical. All seven full CD cases, C3-C5 and original variants/repeats/M/CW obligations remain open.

**User-reported CD output regression:** a new run returned a conclusion referring to an absent commitment register, compared with the earlier full register. The user requested explanation only and no troubleshooting; no cause or acceptance was inferred from pasted output.
