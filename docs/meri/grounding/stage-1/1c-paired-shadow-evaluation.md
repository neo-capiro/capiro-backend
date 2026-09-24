# Stage 1c: paired-shadow evaluation

Stage 1c is offline reporting only. It consumes the post-release events documented in Stage 1b and optional development recordings; it does not change, hold, or retrieve for an answer.

## Export pilot events

Every Meri structured event is one JSON object per log line with an `event` field, for example `{"event":"meri.evidence_shadow","conversationId":...}`, printed behind the Nest console logger header (`[Nest] <pid>  - <timestamp>     LOG [MeriV3AssistantService] `) which the export strips. Emission is already scoped by the rollout flags to the canonical pilot tenant and the `chat` surface; constrain the time range with `--start-time` (epoch milliseconds). From an authenticated shell with read access to the pilot log group, export the claim and turn events in one pass (the filter pattern `"meri.evidence_shadow"` matches both `meri.evidence_shadow` and `meri.evidence_shadow.turn`):

```bash
START=$(( ($(date +%s) - 24*3600) * 1000 ))   # 24 hours back, in epoch milliseconds
aws logs filter-log-events --log-group-name /capiro/dev/api --start-time "$START" --filter-pattern '"meri.evidence_shadow"' --output json | jq -r '.events[].message' | sed 's/\x1b\[[0-9;]*m//g' | grep -o '{"event":.*}' > events.jsonl
```

`jq` extracts each log message, `sed` removes ANSI colour codes and `grep -o` keeps only the JSON object, so the logger header, free-form surrounding logs, credentials, headers and prompts never enter the export. When the response carries a `nextToken`, repeat the command with `--next-token <token>` and append (`>>`) until it is absent. `meri.evidence_shadow.failed` lines that match the pattern are counted as unrelated by the report and need no removal. Do not widen the log group, time range or filter pattern to capture other tenants' events. Store the export in an access-controlled local working directory and run:

`pnpm --filter @capiro/meriv2-core eval:jev-shadow-report -- --events <export.jsonl> --labels <labels.json> --out <directory>`

All inputs are optional except `--out`. `--events` alone produces a live-only report and never mixes fixture providers into production data. To replay the fixed fixture corpus as well, opt in with `--include-fixtures` and optionally `--recordings <recordings.jsonl>`; without a recordings argument that mode creates an empty store and reports fixture replay misses. The command performs no network calls.

## Adjudication

A label file has version `jev_human_labels_v1`. Each label identifies a claim by `claimId` or `envelopeHash`, provides one of the four evidence outcomes, and records `status`, `reviewer`, `reviewedAt`, and `note`. New adjudications begin as `proposed`. A designated grounding/product reviewer compares the exact bounded evidence, claim scope and dates, then changes the status to `approved`. Only approved labels contribute to metrics; proposed labels remain visible workflow state and are ignored. Overrides take precedence over approved fixture labels.

Preserve the fixture's fixed tuning/held-out split. Use tuning rows to compare threshold candidates. Inspect held-out metrics only for a separately, human-chosen threshold. Never transfer a threshold to another task, question version, or model.

## Reading the report

`shadow-report.json` is the machine-readable artifact and `shadow-report.md` is its deterministic digest. The content hash covers the JSON payload excluding the rendered Markdown and hash itself.

For each provider, inspect outcome distribution, Jev/legacy agreement, labeled accuracy and per-outcome precision/recall, the full outcome/failure confusion matrix, category and claim-kind slices, and operational failure rate. `unlabeled` is reported separately and never enters accuracy. Jev confidence bins are width 0.1. Turn events provide token/cost totals, skipped claims, and budget exhaustion. Sampled agreements counter disagreement-only review bias; the disagreement digest truncates claim text to 160 characters and retains both decisions and envelope hash.

A report refuses mixed model names or question versions per provider and lists the values found. Generate separate reports instead of averaging incompatible contracts. A `No live events` section means the output is fixture replay evidence only, not pilot evidence.

Legacy baseline events also carry `legacyAdapterVersion`. Version `legacy-skeptic-adapter.v2`
maps a legacy refutation with no bound, non-empty evidence passage to
`insufficient_evidence` with reason `legacy_could_not_confirm`; evidence-bound
refutations remain `contradicted`. Reports refuse to combine v1 and v2 events. The
v1 adapter remains on live repair because that cascade can change a released answer.

The comparison budget is registered with the `claim_support` task: 12 claims,
60,000 estimated input tokens, and a 6,000 ms deadline by default. Raising the
deadline can increase claim coverage but also adds judge calls and cost; lowering it
reduces cost and post-release work while increasing skipped claims and
`budgetExhausted` turns. This work is scheduled only after text emission in
`meriv3-assistant.service.ts`, so the budget cannot hold or rewrite the reply.
