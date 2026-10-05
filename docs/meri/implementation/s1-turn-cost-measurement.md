# Stage 1 §4.6 turn cost measurement (2026-10-05)

Program plan §4.6 says to measure first, then trim in order, and to stop when a typical turn is under the 272,000-token long-context surcharge. This records the measurement and the decision.

## Where the numbers come from

`meri.api.turn.finalized` carries no token usage by design: `meriv3-proxy.service.ts` leaves usage to the orchestrator's joined events. Use the orchestrator events in `/capiro/dev/api` (log stream prefix `meriv2-orchestrator`) instead.

Per turn, from `meri.canary.turn` (one per V3 chat turn):

```text
fields @timestamp, @message
| filter @logStream like /meriv2-orchestrator/ and @message like /meri.canary.turn/
| parse @message /"tenantId":"(?<tenant>[^"]+)"/
| parse @message /"synthesis":(?<synth>[0-9]+)/
| parse @message /"estimatedCostUsd":(?<cost>[0-9.]+),"sampled"/
| parse @message /"total":(?<ms>[0-9]+)\}/
| stats count(*) as turns, avg(synth) as avgInput, pct(synth,50) as p50Input, pct(synth,90) as p90Input, max(synth) as maxInput, avg(cost) as avgCost, sum(cost) as totalCost, avg(ms) as avgMs by tenant
```

Per model call, from `meri.provider.attempt.finalized`:

```text
fields @message
| filter @logStream like /meriv2-orchestrator/ and @message like /meri.provider.attempt.finalized/
| parse @message /"inputTokens":(?<inp>[0-9]+)/
| parse @message /"cacheReadTokens":(?<cached>[0-9]+)/
| stats count(*) as calls, avg(inp) as avgIn, pct(inp,50) as p50, pct(inp,90) as p90, max(inp) as maxIn, avg(cached) as avgCached
```

## Results, 7 days to 2026-10-05

| Measure | Value |
| --- | --- |
| Chat turns | 193 |
| Model calls | 623 (about 3.2 per turn) |
| Input tokens per call | average 74,900; median 73,900; 90th percentile 117,400; maximum 221,300 |
| Share of input served from cache | about 65% (average 48,700 cached per call) |
| Input tokens per turn, capiro-internal (138 turns) | average 288,300; median 188,500; 90th percentile 570,000 |
| Cost per turn by tenant | $0.18 to $6.53 average; $332 total for the week |

## Decision

- No single request crosses 272,000 input tokens, so the long-context surcharge is not being paid per request.
- The median turn (188,500) is under the target. By the plan's stop rule, steps (1) to (3) are not required now.
- The cost lives in the fixed per-call prefix (about 74,000 tokens on the first call of a turn: instructions, tool schemas, context packet), repeated about 3.2 times per turn, and in a long tail (case 45 used 831,000 input tokens for one 80-page document turn).
- Recommended later, not done in Stage 1: a per-turn input-token ceiling behind a tenant flag (step 3) to bound the tail, and a review of which tool schemas are exposed on every call. Revisit if the median turn rises above 272,000 or a single request approaches it.
