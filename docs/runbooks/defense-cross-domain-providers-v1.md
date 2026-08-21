# Runbook — Defense cross-domain providers (v1)

Operating the two Workstream-E cross-domain providers wired by Phase 8 Session 9:
free-text capability search (`EmbeddingPort`) and client relevance on
needs-attention (`ClientRelevancePort`).

**Current state: both dark in every environment.** No credential is provisioned
anywhere. This runbook is what to do when that changes, and how to tell what is
happening when it has.

---

## 1. The one thing to understand first

Both ports **degrade silently by contract**. That is correct product behaviour —
the routes serve an honest empty state rather than a 500 — and it means you cannot
tell from the UI whether:

- the answer genuinely is empty,
- no provider is configured,
- the provider is throttling you,
- or the credential expired.

All four look identical to a user. `defense_provider_invocation` is the only place
that distinguishes them. **Start there, not in the UI.**

## 2. Reading the state

```sql
-- What happened in the last hour, by outcome.
SELECT provider, operation, outcome, failure_class, count(*), max(started_at)
FROM defense_provider_invocation
WHERE started_at > now() - interval '1 hour'
GROUP BY 1,2,3,4
ORDER BY 5 DESC;
```

| Outcome | Meaning | Action |
|---|---|---|
| `succeeded` | provider answered usefully | none |
| `degraded_unconfigured` | no provider selected | expected while dark; see §3 if unexpected |
| `degraded_failed` | provider was called and failed | read `failure_class` (§4) |
| `degraded_concurrency` | in-flight cap reached, call refused | §5 |
| `degraded_empty_input` | nothing to ask about | none; not a fault |

The table holds **no query text, no PE codes, no vector and no secret** — only
digests, counts and outcomes. If you need to correlate a specific user request,
use `idempotency_key`, which is stable for an identical request from the same
tenant.

## 3. Turning a provider on (activation)

Activation is a **deployment** act. Session 9 wires the code; it provisions
nothing. Both switches are required — a credential alone will not turn a dark
deployment live, by design.

### Embedding (capability search)

```text
DEFENSE_EMBEDDING_PROVIDER = bedrock            # required switch
DEFENSE_EMBEDDING_REGION   = us-east-1          # required, must be an AWS region
DEFENSE_EMBEDDING_MODEL    = amazon.titan-embed-text-v2:0   # optional
DEFENSE_EMBEDDING_TIMEOUT_MS   = 5000           # optional, 100..30000
DEFENSE_EMBEDDING_MAX_ATTEMPTS = 3              # optional, 1..5
```

> **The model id is not cosmetic.** Every vector read filters on
> `context_embeddings.model`. If this does not match what `apps/api` stored, the
> search returns **zero rows with no error** — it looks exactly like "no results".
> Confirm the two agree before blaming relevance quality.

The task also needs AWS credentials with `bedrock:InvokeModel` for that model.
Prefer the task role over static keys.

### Client relevance (needs-attention)

```text
DEFENSE_CLIENT_RELEVANCE_PROVIDER = internal_service    # required switch
DEFENSE_MAIN_API_BASE_URL         = https://api.capiro.ai
DEFENSE_MAIN_API_INTERNAL_SECRET  = <the main API's INTERNAL_SERVICE_SECRET>
DEFENSE_CLIENT_RELEVANCE_MAX_BATCH = 50         # optional, 1..200
```

`DEFENSE_MAIN_API_BASE_URL` must be a bare **https** origin — no path, query or
fragment — or selection stays dark. The secret must equal the main API's
`INTERNAL_SERVICE_SECRET`; the guard on the far side is fail-closed, so a wrong or
missing value yields `unauthorized`, which is **not retried**.

### Verifying activation took effect

On boot the service logs one line per port:

```text
cross-domain providers bound: embedding=bedrock_embedding clientRelevance=internal_service_relevance
```

If a port reads `dark` after you set the variables, the log line for that port
states the reason verbatim — a malformed region, a non-https base URL, an
out-of-range timeout. Selection never guesses and never throws.

## 4. Diagnosing `degraded_failed`

```sql
SELECT failure_class, count(*), max(reason)
FROM defense_provider_invocation
WHERE outcome = 'degraded_failed' AND started_at > now() - interval '15 minutes'
GROUP BY 1 ORDER BY 2 DESC;
```

| `failure_class` | Cause | Action |
|---|---|---|
| `unauthorized` | wrong/expired secret, or missing Bedrock permission | fix the credential. **Not retried** by design — retrying an auth failure is how a misconfiguration becomes an incident |
| `throttled` | provider rate limit | retried with exponential backoff; if sustained, lower request volume or raise the quota. Provider `Retry-After` is obeyed |
| `timeout` | provider slow | retried; consider raising `*_TIMEOUT_MS`, but note §6 |
| `unavailable` | 5xx | retried; usually transient |
| `invalid_request` | 4xx | a bug or a bad model id; not retried |
| `malformed_response` | 200 with an unusable body | provider contract drift. For embeddings this includes an empty vector or a `NaN` component, which is refused deliberately — a `NaN` would silently poison every cosine comparison |
| `transport` | DNS/TLS/socket | check egress and security groups |

## 5. `degraded_concurrency`

The in-flight cap was reached and the call was **refused rather than queued**.
That is deliberate: queueing on a read path converts a fast empty result into a
slow one.

Occasional refusals under burst are normal. Sustained refusals mean the provider
is slower than the request rate. Reduce latency or accept the degrade — do not
"fix" it by adding a queue.

## 6. Latency budget

Worst-case added latency per request is bounded and computable:

```text
maxAttempts x timeoutMs  +  backoff (100ms, 200ms, 400ms, ...)
```

Defaults (3 attempts, 5000 ms) give a worst case of about **15.3 s** on a read
route. If that is too much for the surface, lower `MAX_ATTEMPTS` before raising
`TIMEOUT_MS`. `totalBudgetMs` caps the whole invocation independently of the
attempt count.

## 7. Turning a provider off

Remove the switch (`DEFENSE_EMBEDDING_PROVIDER` /
`DEFENSE_CLIENT_RELEVANCE_PROVIDER`) or set it to `dark`, and redeploy. The port
reverts to the unconfigured implementation and the routes serve their documented
empty results. Nothing else needs to change and no data is affected — the audit
history is append-only and stays.

This is the fastest rollback: it needs no code change and no credential rotation.

## 8. What this runbook does NOT cover

- **Scheduling.** Session 9 registers none. Production schedule ownership is
  Session 10's.
- **NVIDIA/GPU.** Session 5's `NVIDIA_NOT_ADOPTED` decision stands. The serve
  environment still refuses `NVIDIA_*`, `SAGEMAKER_MODEL_ADMIN_*`,
  `DEFENSE_PARSER_MODEL_*`, `DEFENSE_PROMOTER_*` and
  `DEFENSE_SNAPSHOT_ACTIVATION_*`, and binding providers asserts that at startup.
- **Cost.** No monetary column exists in the provider audit; provider spend is not
  a funding fact and is not tracked here. Use the AWS billing console.
