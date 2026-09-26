# Routing annotation and scoring rubric v1

## Scope

Annotate workflow selection separately from execution and answer quality. A route label is a canonical capability descriptor ID from the frozen candidate catalog, or one of `multi_intent`, `needs_context`, `no_match`. The candidate catalog and its version must be recorded for every evaluated run. Never infer permission, prerequisites, identifiers, or execution eligibility from the model's route suggestion.

## Case annotation

- `acceptableOutcomes`: all semantically valid route labels for the request given the supplied context. Include `needs_context` when a required entity, period, or other material input is absent or ambiguous. Use `no_match` only when no eligible capability addresses the request. Use `multi_intent` when multiple distinct intents are present and a single route would omit a material intent.
- `acceptableSequences`: optional sequences of canonical capability IDs that satisfy all intents and dependencies. Include multiple sequences when order is not unique. An empty list means no sequence oracle was authored, not that no tools are needed.
- `contextState`: state supplied by the synthetic fixture, not an assertion about any live tenant or service.
- `riskTags`: descriptive review dimensions; they are not score weights.
- `split`: keep `unassigned` until a predeclared dataset plan selects development, calibration, or locked holdout membership. Do not move cases based on observed model outcomes.

Two reviewers should independently annotate each case before it enters a scored set. Resolve disagreements in a recorded adjudication pass and preserve both original annotations. For high-impact or write cases, require an independent reviewer and explicit approval/recipient/record constraints in a controlled fixture before execution testing.

## Per-run outcomes (separate scorecards)

Record the following independently for every case; missing evidence is `unverified`, never a pass.

| Dimension | Allowed outcomes | Evidence |
| --- | --- | --- |
| Routing | `correct`, `incorrect`, `acceptable_alternative`, `clarification_required` | Candidate set/version, proposed and selected route, accepted labels/sequences, fallback reason |
| Execution | `usable_evidence`, `empty_result`, `failed`, `not_exercised`, `unverified` | Validated arguments, server-side receipt, source IDs, status/body class, error or availability state |
| Answer handling | `supported`, `unsupported`, `appropriately_limited`, `unverified` | Exact displayed answer and claim-to-source/citation mapping |
| Accuracy | `reference_verified`, `contradicted`, `unverified` | Versioned authoritative source snapshot and exact-field comparison |
| Coverage | `complete_for_declared_scope`, `partial`, `unknown` | Declared scope, source health, counts, paging/omission markers and receipt |

An honest explanation of an execution error may be appropriately limited while execution is failed. Never collapse these outcomes into one overall pass. Factual values, amounts, dates, and identifiers require authoritative fixtures; synthetic prompts alone cannot establish them.

## Aggregate reporting and gates

When the dataset meets its sampling and fixture requirements, report counts and denominators, per-family results, acceptable alternatives, fallback/abstention rate, precision among decisions accepted without fallback, recall of required capabilities, and confidence intervals. Separately report execution positive fixtures versus expected failures and infrastructure outages. Keep capability routing, passage relevance, and post-reply claim-support on distinct datasets and scorecards.

The implementation plan's initial promotion targets are gates to evaluate only after the full set and authoritative fixtures exist: zero scope escapes, approval bypasses, or unauthorized writes; at least 95% acceptable workflow selection overall and 90% per promoted family; at least 98% routing precision among accepted decisions and 99% required-capability recall; every deterministic contract fixture passing; at least 98% supported material claims on reviewed references with zero critical unsupported claims; no material regression; target 15% lower total cost per correctly completed request and no more than 10% p95 latency regression. These are not seed acceptance criteria and are not inferred or tuned here.

Never inspect or tune against locked holdout outcomes during development/calibration. Freeze dataset, catalog, model/question, candidate-generation, scoring, and threshold-policy versions before holdout evaluation. Expand samples when denominators cannot support a conclusion. No threshold may be selected from this 24-case seed.

For the separate dormant, protected-holdout-only route-decision preflight, score an accepted candidate workflow only when its selected label is adjudicated and its exact ordered tool sequence is one of the adjudicated alternatives. A fallback is counted in the full-case denominator and fallback rate, but never in accepted-decision precision or candidate-correctness numerator. The v1 oracle does not pair multiple route labels with sequences, so such cases cannot be scored until a paired oracle exists; a single executable tool label must occur in every acceptable sequence. Do not use a route label to forgive a missing prerequisite; do not use a semantically correct route to infer authorization or execution success. Independently adjudicated required-tool labels must exactly match the common-tool intersection of acceptable sequences, but recall remains `null` if alternative sequences have different tool sets until a reviewed clause/coverage oracle exists. Mere order differences preserve a known denominator. Missing labels also produce `null`, not a pass. Receipt and oracle references must be one-to-one with cases, but the preflight's structural result still does not authenticate any source, receipt, candidate manifest, batch, or reviewer; `evidenceAuthenticated` remains false and promotion remains disabled.
