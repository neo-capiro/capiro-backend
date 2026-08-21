# Phase 8 Session 9 — Cross-Domain Provider Runtime

**Provider/runtime integration. Dark by default.**

Sessions 2 and 3 built the Workstream-E read surface and then deliberately left
two seams unfilled, saying exactly why:

> "They are NOT stand-ins for unwritten business logic: the routes that consume
> them implement their full query, ranking and shaping against real data (see
> `searchCapabilityLines` / `getNeedsAttention`). What is absent in dark posture
> is the **OUTBOUND CREDENTIAL**, deliberately — the HTTP task holds no Bedrock or
> main-API service credential, and Session 3 authorizes no new one. **Session 9
> (shadow read) is where these get wired to real providers.**"
> — `cross-domain/ports.ts`

> "The two cross-domain ports … exist as INJECTION TOKENS rather than direct
> imports so **Session 9 can bind a real provider** without touching a single read
> service."
> — `program-elements.module.ts`

> "the query, ranking and enrichment below are the real implementation and **run as
> soon as a provider is wired (Session 9)**."
> — `budget-lines-read.service.ts`

Session 9 is that wiring. It adds no route to the frozen 49-route defense-api
surface, no schedule, no promotion, and no GPU.

> **Scope note.** No Session 9 specification document exists in this repository —
> there is no `phase8-session9-*` doc and no Phase 8 master handoff (its absence
> was established during Session 8 and is unchanged). The three quotations above
> are the authoritative in-repo definition, and the one contract change they imply
> — an additive internal route on the main API — was explicitly authorized by the
> operator before implementation, because completing `ClientRelevancePort` is
> impossible without it.

---

## 1. What was actually missing

Nothing about ranking, scoring or shaping. Two things:

| Port | Missing | Consequence today |
|---|---|---|
| `EmbeddingPort` | a text→vector provider | free-text capability search serves an empty result |
| `ClientRelevancePort` | a way to ask the main API | needs-attention serves watch/capability relevance only |

Both are documented to **degrade, not throw**, and both read routes rely on that
to serve an honest empty state instead of a 500. That single fact shapes every
decision below.

## 2. Dark by default, and a credential is not a switch

`selectCrossDomainProviders` is the only place that decides dark or live, and it
fails closed:

- a provider is selected **only** when its configuration is completely present;
- anything missing, malformed or contradictory selects `dark`;
- selection never throws — a config typo must not take down a route documented to
  degrade;
- every dark selection carries a **reason**, because "the search box is empty" and
  "the provider was misconfigured" must not be indistinguishable in the logs.

The explicit switch (`DEFENSE_EMBEDDING_PROVIDER`,
`DEFENSE_CLIENT_RELEVANCE_PROVIDER`) is required. A credential appearing in the
environment — as it might from a shared task definition — is deliberately **not**
enough to turn a dark deployment live.

With no configuration present, both ports resolve to the same
`UnconfiguredEmbeddingPort` / `UnconfiguredClientRelevancePort` that Sessions 2–8
shipped. An unconfigured deployment behaves exactly as it did before this session.

## 3. The Session 3 credential boundary is intact

Session 3 froze the serve task's environment against five credential classes:

```text
DEFENSE_PROMOTER_*   DEFENSE_SNAPSHOT_ACTIVATION_*   NVIDIA_*
SAGEMAKER_MODEL_ADMIN_*   DEFENSE_PARSER_MODEL_*
```

Session 9 introduces an **embedding** credential and reuses the main API's
**existing** internal-service secret. Neither is in that set, which is precisely
why this session can wire providers without changing the frozen boundary.

`assertNoForbiddenProviderConfig` runs at the moment providers are bound and
fails **loud** — unlike a provider construction failure, which degrades. A
forbidden credential in the serve environment is a boundary violation, not a
degraded provider, and Session 5's `NVIDIA_NOT_ADOPTED` decision is untouched.

## 4. Retry: bounded, deterministic, and classified first

A retry that is too eager turns one slow provider into a stalled read route; one
that is too shy turns a single throttle into a silently empty search box. So
failures are **classified before they are retried**:

| Class | Retryable | Why |
|---|---|---|
| `timeout`, `throttled`, `unavailable`, `transport` | yes | transient |
| `unauthorized` | **no** | a wrong secret will be wrong next time; hammering an auth failure is how a misconfiguration becomes an incident |
| `invalid_request` | no | a 400 is not going to become a 200 |
| `malformed_response` | no | the provider answered; the answer was unusable |

Backoff is exponential with **no jitter** — a replay has to reproduce the
schedule, and read-path latency must be predictable rather than merely bounded. A
provider `Retry-After` is obeyed when it asks for *longer* than our own backoff,
never to go faster.

`totalBudgetMs` bounds the whole invocation independently of `maxAttempts`, so an
attempt count can never multiply into an unbounded request.

Exhaustion is an **outcome**, not an exception: the caller receives `null` and
serves its documented empty result.

## 5. A 200 with an unusable body is a failure

`interpretTitanEmbedding` returns `null` for an empty vector, a non-numeric
element, or a `NaN`/`Infinity` component — and the runner then classifies that as
`malformed_response` rather than recording an empty success. A `NaN` would
silently poison every cosine comparison downstream, which is exactly the class of
bug that is invisible in production.

Symmetrically for relevance: an **empty array is a valid answer** ("none of these
are relevant") and is returned as such; a non-array body is malformed. And only
codes that were actually requested are accepted back, so a provider echoing an
unrequested code cannot inject relevance for a PE that was never a candidate.

## 6. Concurrency is refused, never queued

These calls happen on a read route, so a slow provider under load would otherwise
accumulate unbounded in-flight requests inside the HTTP task. The gate is **per
provider**, and a refusal is a normal outcome the caller degrades on.

It is deliberately not a queue: queueing on a read path converts a fast empty
result into a slow one, which is strictly worse than the empty result the route is
documented to serve.

Both ports are bound **once**, from a single factory call, so they share one
runner and one gate map. Binding twice would give each port its own gates and
silently double the effective in-flight cap.

## 7. The audit row, and what it must not contain

Both ports degrade silently by contract, so without a record an empty capability
search is unattributable: a genuinely empty result, an unconfigured provider, a
throttle and an expired credential all look identical from outside.

Every invocation writes one row — including the ones that never reach the
provider, because "nobody asked" and "the answer was empty" must be
distinguishable.

What the row deliberately cannot hold:

- **the query text or the PE-code list** — only a SHA-256 digest;
- **the embedding vector** — only its dimension;
- **any secret** — no column can express one, and a credential-shaped *value* is
  refused regardless of its field name;
- **any monetary or cost column** — provider spend is not a funding fact.
  Sessions 7 and 8 asserted no dollars and so does this one, measured against
  `information_schema` rather than asserted in prose.

`assertProviderAuditCarriesNoSecrets` walks the record at any depth, the way
Session 7's signal guard walks a payload for funding keys, and
`buildProviderAudit` runs it — so there is no path that produces a row without the
guard having run.

The database enforces coherence independently: a `degraded_failed` row **must**
name a failure class and nothing else may carry one; a degraded row cannot claim
an embedding dimension; a success must have produced something; a relevance call
cannot carry a model and an embedding call cannot carry a count.

Writing the row cannot fail the request. A read route that degraded correctly but
500'd because its audit insert failed would be a worse outcome than the
degradation it was recording.

## 8. Idempotency

The key is `sha256` over `{provider, operation, model, tenantId, payloadDigest}`
with canonically-sorted JSON, so key order cannot change it. Two properties matter:

- **the payload is hashed, never carried** — the key proves two invocations were
  the same without recording what they were;
- **the tenant is part of the key** — the same query from two tenants is two
  invocations, and collapsing them would let one tenant's result serve another's
  request.

## 9. The one additive route

`ClientRelevancePort`'s contract already specified what the provider needed:

> "ONE call for the whole candidate set. `apps/api` answers the same question with
> up to 50 sequential per-PE probes (`MAX_RELEVANCE_PROBES`). The batched shape is
> a deliberate improvement required by the Workstream E gate ('no unbounded N+1
> fanout'); the ANSWER is the same set."

The main API had that logic only **in process** — no endpoint — so completing the
port required one. `POST internal/program-elements/relevance/batch` is it,
deliberately narrow:

- on the **existing** `internal/*` path behind the **existing**
  `InternalServiceGuard`, alongsix other internal controllers. No new auth
  mechanism, no new credential class, and fail-closed: with no secret configured
  the route is denied outright.
- it answers by the identical scoring path
  (`getRelevantClientsForPeByTenantId`, the variant already documented for
  trusted server callers), so the batched answer and the per-PE answer cannot
  diverge.
- **PE codes only.** The per-PE route returns client identities; this one does
  not, because the caller's question is "which of these PEs matter to somebody",
  and returning client names would hand a dark service tenant CRM data it has no
  need for.
- read-only, bounded at 200 codes, and an over-large batch is **refused rather
  than truncated** — a silently trimmed batch comes back looking like "those PEs
  are not relevant".
- the **defense-api** surface is unchanged: this route is on `apps/api`, so
  Session 3's frozen 49 stay frozen.

## 10. Implementation, not activation

Session 9 wires providers. It does not turn them on.

```text
AWS mutated:                  NO
Production DB mutated:        NO
Production schedules changed: NO
Production routes changed:    NO   (defense-api still exactly 49)
Snapshot promoted:            NO
NVIDIA provisioned/restarted: NO   (Session 5 remains NVIDIA_NOT_ADOPTED)
Live provider call made:      NO   (no credential configured in any environment)
Provider spend:               $0
```

No credential is provisioned by this session, in any environment. Activation is a
deployment act: it means putting a provider switch and a credential on a task
definition, which is deliberately outside a session that changes no infrastructure.
The runbook documents exactly what that would involve and what to watch.

Both ports remaining dark is therefore the **expected** post-merge state, and the
gates assert it rather than treating it as incomplete.

## 11. Commands

```bash
# Domain + runtime
node scripts/test-phase8-session9-provider-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test \
  src/program-elements/cross-domain/provider-runtime.spec.ts

# Gates
node scripts/verify-phase8-session9.mjs
node scripts/verify-phase8-session9-db.mjs
```
