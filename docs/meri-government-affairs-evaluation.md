# Meri government-affairs output evaluation

This harness compares the same synthetic client and evidence packet through the production chat prompt, configured reasoning profiles and `OpenAiResponsesClient`. It does not add a production reasoning engine or change a default model. Retrieval, permissions, conversation maintenance, research execution and the workspace have separate regression checks below.

## What is measured

Six fixtures exercise appropriations, funding, meeting preparation, hearing intelligence, legislative analysis and an executive briefing. Every fixture includes an approved client strategy, capabilities, geography, an earlier attachment constraint, and incomplete facility coverage. Task records include current-versus-stale roles/versions, misleading hearing metadata, fiscal units and stages, or canonical Funding Opportunities eligibility results. All names, amounts and source references are invented evaluation data.

The existing Meri deterministic grader checks a small set of required facts and forbidden regressions. This extension also detects unknown source numbers, loss of required client/task citations and unfinished placeholders. These are **contract checks, not a professional quality score or proof of grounded claims**. Lexical failures need inspection; a passing answer still requires claim-by-claim professional review. The authored reference answers validate fixture contracts only and are never sent to the provider.

## Run the offline contract checks

From the repository root after installing dependencies and building shared packages:

```bash
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/meri/evals/government-affairs-grader.spec.ts
pnpm --filter @capiro/api eval:meri:government-affairs --out /tmp/meri-ga-contract.json
```

The CLI defaults to offline mode. Its report explicitly records zero provider calls and no measured professional quality. In environments where the `tsx` CLI cannot create its local IPC socket, use the same loader directly:

```bash
node --import tsx apps/api/scripts/eval-meri-government-affairs.ts --out /tmp/meri-ga-contract.json
```

## Run the provider comparison

Use the existing deployment/account environment, with `OPENAI_API_KEY` available through the normal secret injection. Do not put credentials in arguments or reports. Standard resolves from the existing Standard configuration; Deep uses the existing Deep model with `high` effort. The third candidate requires an explicit `MERIV3_MAX_MODEL` from the account's available models. The harness cannot discover or certify which account model is strongest. Configuring the Max slot for a benchmark does not change deployed settings, and successful requests establish availability only.

```bash
pnpm --filter @capiro/api eval:meri:government-affairs --live --samples 1 --out /tmp/meri-ga-live.json
```

The default is at most 18 sequential requests: six tasks by three configurations. Profile order rotates by task/sample. All candidates receive the identical evidence and production prompt, a common 4,096 output-token ceiling, a 120-second request timeout and a 20-minute total deadline. These evaluation limits deliberately differ from normal production turn budgets and are saved in the report. `--samples` accepts 1–3; `--max-output-tokens`, `--timeout-ms` and `--total-budget-ms` have enforced upper bounds. Partial, timed-out and failed runs are reported and cannot count as completed quality results. Stop interrupts the current provider call and prevents scheduling another. Results are saved after each call, so an interrupted comparison retains completed rows.

The runner records the actual response ID, requested/effective model and effort, fallback reasons, finish reason, partial status, provider token usage and elapsed latency. It records cost only as an **estimate using existing repository prices**, with unknown models returning null. Actual billed cost remains null because the Responses result does not supply a provider invoice. Failed requests have unknown usage and cost, not fabricated zeros. Prices and account entitlements are not verified by this benchmark. The report never saves provider reasoning or raw provider errors.

This is a controlled **output** comparison with supplied evidence and no tools. It cannot establish whether live retrieval finds a strategy or transcript. It also cannot establish equality with ChatGPT or Hermes without comparable outputs and review. Keep the existing defaults until live output and usability results support a change.

## Review professional quality

Have a government-affairs reviewer read each answer against its fixture records and four task-specific `reviewChecks`. For an actual selection, collect repeated runs and independent reviews, ideally with model labels hidden while scoring. Score each of the following from 0 to 4:

| Dimension           | Required substance                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Client implication  | Recommendation connected to actual objective, capability, geography and constraints                    |
| Verified evidence   | Supported claims, observation date, exact record/section, correct fiscal year, amount, units and stage |
| Judgment            | Facts separated from inference; useful alternatives and material uncertainty                           |
| Practical action    | Feasible owner, verified target, deliverable and supported deadline, or explicit unknown               |
| Missing information | Decision-changing gaps and coverage limitations; no absent record treated as a negative fact           |

Anchors: 0 absent or materially wrong; 1 major rework; 2 usable with corrections; 3 professional with minor corrections; 4 decision-ready and supported. Record material errors separately: fabricated eligibility, an invented deadline, a proposed mark represented as enacted, a witness statement represented as policy, loss of a client constraint, or an unsupported source. The local rubric requires at least 16/20, every dimension at least 2, and zero critical errors. This threshold is an explicit evaluation choice, not an externally validated quality standard.

Populate a completed live row's `humanReview` with a named reviewer, date and evidence-based notes:

```json
{
  "reviewer": "Reviewer name",
  "reviewedAt": "2026-09-06T12:00:00Z",
  "scores": {
    "clientImplication": 3,
    "verifiedEvidence": 4,
    "judgment": 3,
    "practicalAction": 3,
    "missingInformation": 3
  },
  "criticalErrors": [],
  "notes": "Checked each material assertion against the supplied records."
}
```

Then compute only those explicitly supplied human scores:

```bash
pnpm --filter @capiro/api eval:meri:government-affairs --score-review /tmp/meri-ga-live.json --out /tmp/meri-ga-reviewed.json
```

The review command rejects offline/reference reports and incomplete provider rows. It does not invent scores for missing reviews. Read per-task outcomes, critical errors, fallback frequency, latency and usage together; resolve deterministic contract failures before using a run for model selection. Do not average away a weak task or change defaults from one attractive answer. The report deliberately makes no automatic model recommendation. Deployment configuration changes require a separate evidence-backed change.

## Release-check map

These tests already exercise the first release's concrete risks; they are not live-model quality measurements. The main gate is `.github/workflows/meriv3-canary-ci.yml`.

| Risk                                                                    | Regression files                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rich client profile reaches native tool                                 | API `meri-client-context.helpers.spec.ts`; orchestrator `api-client-context.repo.spec.ts`; core `tools/client/get-client-context.spec.ts`                                                                                                                                                                                              |
| Forecast tools survive registry filtering                               | API `meri-tools.registration.spec.ts`, `meri-tool-manifest.parity.spec.ts`; orchestrator `meri-capability-contract.spec.ts` and `meriv3/native-capability-routing.spec.ts`                                                                                                                                                             |
| Early constraints and maintenance survive long threads                  | API `meri-compaction.helpers.spec.ts`, `meri-summary-completion.spec.ts`, `meri-turn-maintenance.spec.ts`, `meri-research-handoff.spec.ts`, `meriv3-proxy.service.spec.ts`                                                                                                                                                             |
| Research keeps earlier attachments                                      | API `meri-research-handoff.spec.ts`, `meri-research-continuity.spec.ts`, `meri-v3-research-runner.spec.ts`                                                                                                                                                                                                                             |
| Source-only response keeps initial citations                            | Orchestrator `meriv3/meriv3-context-evidence.spec.ts`; API `meri-context-evidence-projection.spec.ts`                                                                                                                                                                                                                                  |
| Recall keeps client scope and revocation                                | API `meri-memory-context.integration.spec.ts`, `retrieval/adapters/institutional-knowledge-retrieval.adapter.spec.ts`                                                                                                                                                                                                                  |
| Cancellation stops scheduling tools                                     | Orchestrator `api-tool-executor-cancellation.spec.ts` and `meriv3` runtime tests; API `meri-tool-request-control.spec.ts`; core `registry/tool-registry.spec.ts`                                                                                                                                                                       |
| Reasoning changes, drafts, rename, work history and import re-expansion | Web `VNextMeriReasoningControl.test.tsx`, `VNextMeriComposer.drafts-import.test.tsx`, `useMeriChatController.rename-persistence.test.tsx`, `useMeriChatController.feedback-identity.test.tsx`, `VNextMeriMessage.work-performed.test.tsx`, `meri-route-state.test.ts`, `meri-route-identity.test.tsx`, `meri-workspace-import.test.ts` |

The user list contains five UI defect rows; draft navigation and docking are separate reproductions within the draft row. Browser smoke checks should cover both. A long-thread fixture proving context transport does not prove a real provider obeys the retained constraint; include that observation in a live end-to-end release check.


## Durable research release checks

Research now stores its public run phase, status and lease in the existing session. A browser disconnect detaches the stream while the server can continue. Reload recovers the saved session, and explicit Resume retries an interrupted read-only phase with the original conversation, attachments, client scope and preferences. It does not reconstruct private provider reasoning or restart already-completed writes. Concurrent claims and final artifact writes are fenced; cancelled attempts cannot restart without the matching explicit Resume request.

Deploy compatible API, orchestrator and web revisions together. Verify browser detach/reload, simultaneous Resume requests, Stop on a different API replica, Stop during plan setup, changed client access, reviewed report replay, and a worker restart against the deployed database. Local concurrency tests use a stateful harness that evaluates the CAS predicates; they do not replace a multi-replica database smoke test.

The runtime still forwards the initiating user's bearer token to authorized tool calls. Its deployed lifetime was not available in this environment. Long detached runs remain subject to token expiration; a fresh authenticated Resume can retry the saved phase. Verify a real run spanning the configured token lifetime before claiming unattended long-run completion. This release changes no Clerk/JWT/tenant authentication rules and stores no background bearer credentials.

No live provider comparison ran in the implementation environment because no provider credential was available. The offline fixture checks validate the harness and known contracts, not actual professional output quality. Default models and efforts remain unchanged until the live matrix and the five-dimension review support a choice.
