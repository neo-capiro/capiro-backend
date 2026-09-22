# Stage 1c: paired-shadow evaluation

Stage 1c is offline reporting only. It consumes the post-release events documented in Stage 1b and optional development recordings; it does not change, hold, or retrieve for an answer.

## Export pilot events

In the approved pilot log system, query the structured event-name field for `meri.evidence_shadow` and `meri.evidence_shadow.turn`, constrain the time range and canonical pilot tenant, and export each complete structured record as one JSON line. Include both claim and turn events. Do not export free-form surrounding logs, credentials, headers, prompts beyond the bounded logged claim fields, or events for other tenants. Store the export in an access-controlled local working directory and run:

`pnpm --filter @capiro/meriv2-core eval:jev-shadow-report -- --events <export.jsonl> --recordings <recordings.jsonl> --labels <labels.json> --out <directory>`

All inputs are optional except `--out`. With no recordings argument, the runner creates an empty store and reports fixture replay misses. The command performs no network calls.

## Adjudication

A label file has version `jev_human_labels_v1`. Each label identifies a claim by `claimId` or `envelopeHash`, provides one of the four evidence outcomes, and records `status`, `reviewer`, `reviewedAt`, and `note`. New adjudications begin as `proposed`. A designated grounding/product reviewer compares the exact bounded evidence, claim scope and dates, then changes the status to `approved`. Only approved labels contribute to metrics; proposed labels remain visible workflow state and are ignored. Overrides take precedence over approved fixture labels.

Preserve the fixture's fixed tuning/held-out split. Use tuning rows to compare threshold candidates. Inspect held-out metrics only for a separately, human-chosen threshold. Never transfer a threshold to another task, question version, or model.

## Reading the report

`shadow-report.json` is the machine-readable artifact and `shadow-report.md` is its deterministic digest. The content hash covers the JSON payload excluding the rendered Markdown and hash itself.

For each provider, inspect outcome distribution, Jev/legacy agreement, labeled accuracy and per-outcome precision/recall, the full outcome/failure confusion matrix, category and claim-kind slices, and operational failure rate. `unlabeled` is reported separately and never enters accuracy. Jev confidence bins are width 0.1. Turn events provide token/cost totals, skipped claims, and budget exhaustion. Sampled agreements counter disagreement-only review bias; the disagreement digest truncates claim text to 160 characters and retains both decisions and envelope hash.

A report refuses mixed model names or question versions per provider and lists the values found. Generate separate reports instead of averaging incompatible contracts. A `No live events` section means the output is fixture replay evidence only, not pilot evidence.
