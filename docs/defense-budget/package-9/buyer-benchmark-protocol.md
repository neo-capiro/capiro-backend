# Package 9 buyer benchmark protocol

This protocol evaluates whether qualified evidence supports six buyer plan workflows. It is a blinded evaluation design; there are no benchmark results in this packet. Workflow success cannot be inferred from extraction coverage, model confidence, or an internal demo.

## Six plan workflows

1. **Request to enacted comparison:** compare a buyer's requested program/PE funding with enacted authorization and appropriation, preserving fiscal year, account, and source citations.
2. **Restriction and mark change:** identify a changed restriction, report language, or mark affecting a program and distinguish bill text, committee material, enacted law, and agency interpretation.
3. **Program-to-award association:** connect a qualified program/PE to notices, vehicles, orders, and awards without implying a dollar allocation unsupported by source evidence.
4. **Funding and execution trace:** trace authorization/appropriation through transfers, obligations, and outlays; expose timing, residuals, and unsupported joins.
5. **Source-linked plan brief:** produce a concise planning brief where each material claim resolves to exact source bytes/version and page, table, or section evidence.
6. **Change watch and decision update:** compare two dated evidence snapshots, identify additions/removals/changed values, preserve historical changes, suppress duplicate logical notices, and show uncertainty or unavailable sources.

Each workflow must have a frozen prompt/task statement, exact evidence packet and snapshot IDs, expected answer and acceptable abstentions, and a versioned scoring rubric before evaluation. Use at least 30 cases per workflow, stratified across service, Defense-Wide, funding family, fiscal year, and evidence quality; include ambiguous identity, missing/unavailable source, superseded version, and negative cases. These are minimum design counts, not claims about an existing corpus.

## Independent blind adjudication

Two qualified adjudicators who did not build the evaluated workflow independently score anonymized outputs against the frozen evidence packet. Hide system/provider identity, model name, and treatment lane. Resolve disagreements through a third independent adjudicator; retain initial scores and rationale. Authors may clarify rubric wording before unblinding but may not relabel outcomes after seeing lane identity. Report agreement and every adjudication change.

Score each case for factual correctness, evidence traceability, temporal/version correctness, calibrated abstention, unsupported inference, and actionability for the named buyer workflow. A material unsupported dollar allocation, incorrect enacted/restriction status, missing citation for a material claim, or false “no change” is a critical error. Any critical error blocks that workflow from activation pending remediation and a fresh blind cohort.

## Comparison and reporting

Compare the candidate workflow against the buyer's current documented process and a source-grounded human baseline using the same cases and evidence cut. Randomize lane order. Report per-workflow numerator/denominator, critical errors, abstentions, adjudicator agreement, completion time, latency, and cost. Do not pool away workflow-level failures. Include confidence intervals and disclose exclusions and missing evidence.

No live paid provider lane is permitted under this protocol until a named exact-manifest authorization sets a spend ceiling. The inherited paid-provider default is $0 and annual hard cap is $500. AWS qualification spend is bounded by $1,000 annual incremental hard cap. Capture before/after cost and keep measured totals distinct from annualized projections.

## Gate

Benchmark status begins `NOT_RUN`. A workflow can be proposed for shadow evaluation only after its evidence packet, scoring rubric, adjudicators, and cost controls are frozen. Buyer-facing activation requires independent blind adjudication, zero unresolved critical errors, passed operational scenarios relevant to that workflow, lineage-complete evidence, and explicit release authorization. Results do not authorize publication or notifications on their own.
