# Stage 2 canary enablement and rollback runbook

## Preconditions

Do not begin until additive migrations are applied by the release owner, `TYPESAFE_API_KEY` is provisioned, the CDK Jev-provider opt-in is enabled, Stage 1 fixture labels are adjudicated, and a human owner has approved the repair claim categories. Limit version `stage2-canary-limits-v1` is frozen before observing canary results. Scope every control to pilot tenant `17b63099-bc0f-4ac5-b596-496161e9481e` and `chat`; never use `all`.

## Baseline

With all capability modes `off`, export complete `meri.canary.turn` structured records for at least seven days and at least 100 released turns. Preserve the immutable JSONL and generate the baseline report. Record traffic mix and incident periods; do not silently remove failed or held turns. A later canary window should match the baseline duration and traffic mix.

Every Meri structured event, `meri.canary.turn` included, is one JSON object per log line with an `event` field, printed behind the Nest console logger header which the export strips. From an authenticated shell with read access to the log group, export the window (`--start-time` is epoch milliseconds; when the response carries a `nextToken`, repeat with `--next-token <token>` and append with `>>` until it is absent):

```bash
START=$(( ($(date +%s) - 7*24*3600) * 1000 ))   # seven days back, in epoch milliseconds
aws logs filter-log-events --log-group-name /capiro/dev/api --start-time "$START" --filter-pattern '"meri.canary.turn"' --output json | jq -r '.events[].message' | sed 's/\x1b\[[0-9;]*m//g' | grep -o '{"event":.*}' > baseline.jsonl
```

Export the later canary window with the same pipeline into `canary.jsonl`. `readCanaryEvents` parses each line with `JSON.parse` and keys on its `event` field: a line that is not one JSON object is rejected and any other event name is counted as unrelated.

Run offline:

`pnpm --filter @capiro/meriv2-core eval:canary-report -- --events canary.jsonl --baseline baseline.jsonl --out report`

## Enablement order

Change one capability at a time. Keep each dark/off for one deploy observation, shadow for at least 24 hours and 50 governed turns, then enforce for at least seven days and 100 governed turns. Do not advance with insufficient data. Watch `meri.canary.turn` plus the named capability event and compare the report to the frozen limits.

Common enrollment for each family:

- `_TENANTS=17b63099-bc0f-4ac5-b596-496161e9481e`
- `_SURFACES=chat`
- `_MODE=off`, then `shadow`, then `enforce`

Sequence:

1. Evidence accuracy: `MERI_EVIDENCE_ACCURACY_*`; watch citation-integrity and held outcomes.
2. Coverage retrieval: `MERI_COVERAGE_RETRIEVAL_*`; watch `meri.coverage.turn`, follow-ups, residual gaps, and time-to-text.
3. Passage selection: `MERI_PASSAGE_SELECTION_*`; also set `MERI_JEV_PROVIDER_MODE=shadow|enforce`, Jev tenant/surface enrollment, and include `passage_relevance` in `MERI_JEV_TASKS`. Watch fallback, required retention, contradiction retention, Jev latency, and cost.
4. Claim assessment: `MERI_CLAIM_ASSESSMENT_*`; use `MERI_CHAT_EVIDENCE_JUDGE=cascade` and include `claim_support` in `MERI_JEV_TASKS`. Watch provider failures, sampled decisions, and assessment latency.
5. Auto correction: `MERI_AUTO_CORRECTION_*`; set only the human-approved non-empty `MERI_AUTO_CORRECTION_CATEGORIES`. Watch claim/turn repair events, document requests, budget exhaustion, and unchanged unrelated content.

## Independent rollback

Rollback the affected capability by setting only its `_MODE=off`; leave unrelated controls unchanged. For Jev provider/routing incidents, set `MERI_JEV_PROVIDER_MODE=off` and restore legacy routing. For repair incidents, set `MERI_AUTO_CORRECTION_MODE=off` (or clear its categories). Deterministic Stage 0 evidence protections remain enabled according to their own control and are not rolled back with a Stage 2 capability.

Any held turn, required-passage retention below 1.0, generic-warning increase, cross-client evidence, write/tool-policy violation, or material completion regression requires immediate rollback of the capability most recently enabled. Preserve logs and report artifacts, identify the owner, and do not re-enable until the incident is reviewed. Latency, clarification, and cost limit failures also block promotion.

## Stage 2 exit checklist

- Completion and clarification: `current.outcomes`, `current.clarification`, and baseline deltas pass.
- Holds are zero: `limits.holds=pass` and `current.holds=0`.
- Repair succeeds without whole-answer holds: `current.repair`, repair latency limits, and claim events.
- Required/conflicting evidence is retained: `current.passage.requiredRetention=1.0`, contradictory-retained counts, and no invariant errors.
- Coverage follow-up is bounded and useful: `current.coverageFollowUps`, residual gaps, and coverage latency.
- p50/p95 assessment, passage, coverage, repair, time-to-text, and total latency are present and within limits.
- Cost per released/completed turn delta passes. Correctness still requires the separately adjudicated paired-shadow/fixture evidence; cost alone cannot establish a correct turn.
- Provider failures use fallback and do not create holds or refusals.
- The live pilot window has sufficient samples; offline tests or fixture replay alone cannot claim Stage 2 exit.
