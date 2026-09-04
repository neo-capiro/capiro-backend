# Independent §6.2 review — Band A / P46: Verified Tango webhook receiver

**Verdict: `P46_REJECTED`**

**Date:** 2026-08-13
**Reviewed at commit:** `d800dcfde5` (`feat(x-feed): configurable X Intelligence dashboard feed (#948)`)
**Reviewer:** an independent agent. Did not implement, review, fix, merge or deploy P46 or any
phase of this program. Convention followed:
`docs/runbooks/phase-2-independent-live-validation.md` — different reviewer than implementer,
read-only verification, a verdict that is exactly one of two strings, dated approval record.
**Closes (partially):** D-55's recorded deviation — "every row in the completion matrix is
*self-verified only*… the independent-review column is empty because the review has never
happened, not because it passed." This is that review, for P46 only.

**Everything done for this review was read-only.** All source was read via
`git show d800dcfde5:<path>` against `C:\dev\capirov2` — its working tree was not touched.
Test subsets and one throwaway probe were run in the clean detached checkout
`C:\dev\capiro-fo-ga-review-wt`; the probe script was deleted after use. No AWS call, no network
call to MakeGov, no database write, nothing committed.

---

## 1. Scope and what was actually verified

| # | Question asked | Answer |
|---|---|---|
| 1 | Signature verified on raw bytes before any JSON parse/trust? Middleware ordering, not just the handler? | **PASS.** Traced end to end. No path parses or acts on JSON first. |
| 2 | Idempotency enforced at the DB level, not app logic a race could bypass? | **Mechanism PASS, key FAIL.** The unique index is correct; the value it is keyed on is not. |
| 3 | PR #834's fix present at this SHA, not reverted? Any *other* envelope-shape assumption with the same failure mode? | **Fix present. And yes — two more, both worse.** |
| 4 | Do tests construct a real-shaped signature and reject tampered payloads, or mock the crypto? | **PASS on the crypto. FAIL on interop and on the HTTP path.** |
| 5 | Live-verifiable success assertion, or only synthetic fixtures? | **Only synthetic. No real provider payload has ever reached this code.** |

Files read in full: `apps/api/src/webhooks/tango-webhook.service.ts`,
`tango-webhook.controller.ts`, `tango-webhook.spec.ts`, `webhooks.module.ts`,
`apps/api/src/bootstrap/configure-api-http-app.ts` + `.spec.ts`, `apps/api/src/main.ts`,
`apps/api/src/engagement-main.ts`, `apps/api/src/app.module.ts`,
`apps/api/prisma/migrations/20260905010000_tango_webhook_deliveries/migration.sql`,
`apps/api/scripts/diag-tango-webhook-contract.ts`,
`apps/api/src/external/tango/tango.client.ts` (webhook-sample section) and `tango.types.ts`,
`infra/cdk/lib/config.ts`, plus the vendor SDK `@makegov/tango-node@1.1.0`
(`dist/webhooks/signing.js`, `dist/models/Webhooks.d.ts`, `docs/WEBHOOKS.md`,
`docs/API_REFERENCE.md`).

**The decisive evidence in this review comes from the provider's own SDK, which is already a
pinned dependency of this repo and was never consulted for the two facts P46 says it could not
confirm.** Every claim below marked *(executed)* was produced by running P46's own exported
functions against the SDK's own documented payloads and the SDK's own signing helpers — offline,
no network, no key.

---

## 2. What is genuinely correct — stated first, because it is real work

These are not concessions. They were checked adversarially and they hold.

**2.1 The ordering invariant holds, across the whole chain — not just inside the handler.**
§4.6's "webhook raw bytes are verified before JSON trust" is satisfied. Traced:

- `main.ts` → `configureApiHttpApp({ includeTangoRawBody: true })` mounts
  `raw({ type: '*/*', limit: '1mb' })` on `/webhooks/tango` at step 4, **before** the global
  `json()` at step 6. `express.raw()` sets `req._body = true`, so the global JSON parser
  short-circuits and never sees the body. `req.body` reaches the controller as a `Buffer`.
- `app.module.ts` excludes `webhooks/(.*)` from `TenantContextMiddleware` — nothing derives a
  tenant from provider-controlled input.
- The only global guard is `ThrottlerGuard` (`APP_GUARD`), which does not read the body.
- `setGlobalPrefix('api', { exclude: [… 'webhooks/(.*)' …] })` keeps the controller path and the
  raw-parser mount path identical (`/webhooks/tango`). They cannot drift apart silently.
- In the service, `verifyTangoSignature` is called at step 1 over the `Buffer`; `JSON.parse` is
  at step 3, textually and causally after. `payloadDigest` also hashes the raw bytes, not a
  re-serialization.
- `engagement-main.ts` correctly passes `includeTangoRawBody: false` and does not mount
  `WebhooksModule`, so there is no second process hosting this route with the wrong parser.

**2.2 The HMAC implementation is correct, and its tests are real crypto — not mocks.**
This directly answers review question 4 in the positive. `verifyTangoSignature` uses
`node:crypto` `createHmac` + `timingSafeEqual`; the only short-circuits are on the
attacker-supplied value's *format* (hex shape, decoded length), which leak nothing about the
secret. `tango-webhook.spec.ts` signs real bodies with a real `createHmac` and asserts rejection
of: a tampered body, a wrong secret, **a single flipped byte**, eight malformed header shapes,
and an empty body. It also asserts no log line contains the secret **or the expected digest** —
i.e. it treats a forgery oracle as a defect, correctly. Nothing here is stubbed.

**2.3 The retry contract is right, and an unrecorded delivery is never acknowledged.**
A persistence failure is rethrown, not swallowed, and the controller maps it to `503`. Terminal
caller errors are 4xx. `not_configured` is 503, not 4xx — correct, since it is not the sender's
fault. Rejection messages are fixed strings that never distinguish "two bytes off" from
"nonsense". A test pins each mapping.

**2.4 The idempotency *mechanism* is constructed correctly.**
`tango_webhook_delivery_delivery_id_uniq` is a real unique index in the migration. The service
does **no** `findUnique`-then-`create`; it attempts the insert and catches `P2002`. That is the
only construction that survives two concurrent retries, and the spec proves the constraint
arbitrated rather than a pre-read (`createCalls === 2`, `rows.length === 1`). The table has
exactly one unique index, so the `P2002` catch cannot misattribute a different collision.
**The mechanism is right. Section 3 is about what it is keyed on.**

**2.5 PR #834's fix is present at `d800dcfde5` and was not reverted.**
Commit history on the receiver files, oldest → newest:
`343005180` (P46 initial) → `200e845ad` (*"handle BATCH webhook deliveries, and add a contract
probe"* — this is #834) → `bc8909bd1` (review-1 fixes) → `41fe2c21c` (review-2 fixes). The
`events`-array branch and its six-test `describe('readEnvelope — BATCH deliveries')` block are
both intact in the file at this SHA. Two later fix rounds did not remove them.

**2.6 Test subset re-run independently in the clean worktree.**
`src/webhooks/tango-webhook.spec.ts` — **PASS**. Full subset
(`tango-webhook|diag-tango-webhook-contract|configure-api-http-app`): 159 tests, all pass.
One initial failure in `configure-api-http-app.spec.ts` was a 5000 ms Jest default-timeout flake
on `NestFactory.create` on this machine; re-run at `--testTimeout=60000` it is **15/15 PASS**.
That failure is environmental and is **not** counted as a finding.

---

## 3. Findings, severity-ranked

Severity: **P0** = ships broken or exploitable the day the endpoint is registered.
**P1** = high-probability silent loss / defeated control. **P2** = the evidence does not support
the claim. **P3** = real but narrower. **P4** = informational.

---

### F1 · **P0** · Every delivery body the provider's own SDK documents is rejected `missing_delivery_id` → HTTP 400 → never retried → permanent loss of every authenticated event

`apps/api/src/webhooks/tango-webhook.service.ts` · `readEnvelope`

This is the **same failure class PR #834 fixed for `missing_event_type`, still open for
`missing_delivery_id`, in the same function.** #834's own commit message names the consequence
precisely: *"authenticated, recorded nowhere, and answered 400 so the provider would never retry
it. That is the worst possible failure for this receiver."* That sentence is still true here.

`readEnvelope` resolves the delivery id from
`[body.delivery_id, body.deliveryId, body.id, deliveryHeader]`. The provider's SDK at the pinned
version `@makegov/tango-node@1.1.0` documents **two** delivery body shapes, and **neither carries
any of those three keys, at either level**:

- `dist/models/Webhooks.d.ts` — `WebhookSampleDelivery { timestamp: string; events: Array<Record<string, unknown>> }`. No id field.
- `docs/WEBHOOKS.md` §"Test my handler in a unit test" — the canonical batch body:
  `{ timestamp, events: [{ event_type: "alerts.contract.match", record: { piid: "ABC123" } }] }`. No id.
- `docs/WEBHOOKS.md` §"Generating signatures (for testing)" — the single-event body:
  `{ event_type, alert_id, query_type, filters, matches, checked_at }`. No id. (`alert_id` is the
  *subscription* id, constant across every delivery of that alert — reading it as a delivery id
  would be catastrophic in the opposite direction.)

*(executed)* — P46's own `readEnvelope`, run against both shapes verbatim:

```
[1] SDK docs/WEBHOOKS.md canonical batch body       -> REJECTED  missing_delivery_id
[2] SDK docs/WEBHOOKS.md single-event body          -> REJECTED  missing_delivery_id
```

Under the controller's own documented retry contract, `missing_delivery_id` → `400` →
*"will never succeed as sent. Stop retrying."* So on the provider's own published evidence, the
first real delivery after the endpoint is registered is answered 400 and is gone. There is no
dead-letter, no row, and — because the receiver rejects before the insert — no trace beyond one
`warn` line.

The only thing standing between this and total loss is F2.

---

### F2 · **P0** · The one surviving delivery-id path is an unsigned, entirely undocumented header — so the "whole replay defence" is keyed on attacker-controlled input

`tango-webhook.service.ts` · `TANGO_DELIVERY_HEADER = 'x-tango-delivery-id'`

Given F1, `deliveryHeader` is not a "last resort for a provider that sends no id in the body at
all" as the code comment frames it — **it is the only path that can ever fire.** And:

`x-tango-delivery-id` **appears nowhere outside Capiro's own source.** Verified by
`git grep` across the repo at `d800dcfde5` (3 hits, all Capiro files) and by grepping the entire
vendor SDK — `dist/`, `docs/API_REFERENCE.md`, `docs/WEBHOOKS.md`, `README.md`. The SDK documents
exactly **one** delivery header, `X-Tango-Signature`. There is no corroboration of any kind for
this header's existence. It is weaker evidence than `x-tango-signature`, which at least appears
in the SDK (see F4).

Two outcomes, both bad:

- **The header does not exist** → F1 in full: every delivery 400s, permanently lost.
- **The header does exist** → the HMAC covers the body only, so the header is unauthenticated and
  fully attacker-controlled. The migration calls the unique index *"the whole replay defence"*.
  Keyed on an unsigned header, it defends nothing.

*(executed)* — one captured signed body, replayed under three forged headers:

```
[4] ONE signed body replayed under 3 unsigned headers -> ["forged-1","forged-2","forged-3"]
    distinct rows the unique index would allow: 3
```

An attacker who observes a single valid delivery (a TLS-terminating proxy, a log, a mirrored
request, a compromised intermediary) can replay it unbounded, each replay a fresh `received` row
that P47 drains and P48 fans out into real client alerts. **This is precisely the vulnerability
`readEnvelope`'s own comment says was found and fixed** — *"an earlier version preferred the
header… and that let one captured signed body replay under unlimited distinct delivery ids."*
The fix ("the signed body wins") is correct in form but inert in fact, because the signed body
carries no id to win with. The comment's escape hatch — *"`diag-tango-webhook-contract` reports
whether the body carries an id, and if it does, this branch never runs"* — is doing all the work,
and that diagnostic has never been run (F10) and would not catch this correctly anyway (F5).

---

### F3 · **P1** · The provider's own verifier accepts a bare-hex signature header; P46 rejects it as malformed → 401 → never retried

`tango-webhook.service.ts` · `verifyTangoSignature`, `SIGNATURE_PREFIX`

The SDK's `dist/webhooks/signing.js` — which its docs state *"mirror the canonical Python
implementation in `tango.webhooks.signing` and the tango server (`webhooks/utils.py`)"* — accepts
**both** forms:

> `parseSignatureHeader` — "Accepts both the canonical `sha256=<hex>` form and a bare hex string
> for forward/legacy compatibility (in which case `algorithm` defaults to `sha256`)."

P46 hard-requires the `sha256=` prefix and classifies a bare hex digest as
`malformed_signature` → `401` → *"will never succeed as sent. Stop retrying."*

*(executed)* — same bytes, same secret, both verifiers:

```
canonical "sha256=<hex>"  -> SDK verifySignature: true    P46: {"ok":true}
LEGACY bare hex           -> SDK verifySignature: true    P46: {"ok":false,"rejection":"malformed_signature"}
```

The provider ships legacy compatibility because the legacy form occurs. If any endpoint, any
tenant, or any older server path emits it, every such delivery is 401'd and permanently lost —
and a 401 reads in the logs as an *attack*, not as a contract mismatch, so it would be triaged in
exactly the wrong direction. Same failure class as #834: the SDK types/docs say one thing, the
receiver handles a narrower thing.

Related, same file: the SDK's docs are explicit — *"Use the SDK's `verifySignature` helper —
**do not hand-roll HMAC**."* P46 hand-rolls it. The hand-rolled crypto is itself correct (2.2);
the divergence is in the accepted *encodings*, which is exactly what hand-rolling costs you.

---

### F4 · **P1** · The mitigation chosen for the "unverified header" risk is strictly weaker than one available for free, and the risk statement in the handoff is factually wrong

`docs/plans/funding-opportunities-makegov-v1/HANDOFF-P46-P51.md` §5;
`apps/api/scripts/diag-tango-webhook-contract.ts` header comment

Both documents assert:

> *"P46's signature header is still an assumption. `x-tango-signature` comes from the plan
> document."*
> *"P46's receiver takes two things from the PLAN DOCUMENT rather than from anything the provider
> confirmed."*

**This is not accurate at `d800dcfde5`.** The provider's SDK — already a pinned dependency,
already the thing `tango.client.ts` imports — exports the constants directly:

```
export const SIGNATURE_HEADER = "X-Tango-Signature";
export const SIGNATURE_PREFIX = "sha256=";
```

plus `verifySignature`, `generateSignature`, `parseSignatureHeader`, and a doc line stating the
scheme in full: *"the header `X-Tango-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw body
bytes keyed by your endpoint's secret."*

*(executed)* — `SIGNATURE_HEADER.toLowerCase() === TANGO_SIGNATURE_HEADER.toLowerCase()` → `true`.

Two consequences, and the second is the one that matters:

1. The header-name risk is **much lower** than the handoff claims, and the program has been
   carrying a scary-sounding open risk that a five-line offline assertion would have closed.
2. **Nothing in `apps/api` imports any of these SDK symbols** (`git grep` for
   `SIGNATURE_HEADER|verifySignature|generateSignature|parseSignatureHeader` across `apps/api`
   returns only Capiro's own `TANGO_SIGNATURE_HEADER`). So the correspondence is real but
   **unpinned**: an SDK bump that changes the header, the prefix, or the accepted encodings
   breaks the receiver silently, with no failing test. The chosen mitigation instead defers to a
   live network probe that requires a key nobody has run (F10) — a strictly weaker control than
   a free, offline, always-on one.

This is a direct instance of the program's own D-29 rule about not confusing static-surface
evidence with live evidence — applied here in the opposite direction: real static evidence was
available and was treated as if it did not exist.

---

### F5 · **P2** · The diagnostic built to de-risk P46 would pass a provider the receiver cannot read, and checks the header *name* while ignoring the two assumptions that actually break things

`apps/api/scripts/diag-tango-webhook-contract.ts`

Three defects in the one tool whose entire job is telling a reviewer what is true:

- **`KNOWN_ID_KEYS` does not match the receiver.** The diagnostic accepts
  `['delivery_id', 'deliveryId', 'id', 'external_id']`; `readEnvelope` reads
  `[delivery_id, deliveryId, id]` — **no `external_id`**. A provider that names its id
  `external_id` makes the diagnostic print *"All checked assumptions agree with the provider
  sample"* and exit `0`, while the receiver 400s every delivery. A confident wrong answer, from
  the diagnostic, about the exact fact F1 turns on. This is D-52's own rule (*"a confident wrong
  answer is worse than a crash"*) violated in the successor tool.
- **The envelope-shape check is hardcoded `agrees: true`.** It can never fail, so it cannot
  contribute to the exit code — it is a print statement wearing a check's clothing.
- **It checks the header NAME only.** It does not check `SIGNATURE_PREFIX` / the accepted digest
  encodings (F3), and it cannot check the signed-input construction (raw body vs.
  timestamp-concatenated) at all, because `signature_header` is a format string, not a sample
  signature. The handoff presents running this probe as step 1 that de-risks P46; it de-risks
  one of at least four signature-path assumptions, and it is the one already corroborated by the
  SDK (F4).

---

### F6 · **P2** · No test exercises the real HTTP path; the one plumbing property whose failure is silent and total is untested — and the SDK ships the exact offline recipe for testing it

`tango-webhook.spec.ts` · `describe('TangoWebhookController status mapping')`;
`configure-api-http-app.spec.ts`

- The controller tests build `new TangoWebhookController(service)` where `service.receive` is a
  stub returning a fixed outcome, and pass `req = { body: Buffer.from('{}') } as never`. They
  prove the outcome→status mapping and **nothing else**. No request traverses express, the raw
  parser, the guard chain, or Nest's `@Headers` binding.
- `configure-api-http-app.spec.ts` asserts the **Clerk** raw parser is registered (weakly, via a
  404) and asserts the email-signature parser. It asserts **nothing** about the Tango raw parser:
  `includeTangoRawBody` appears only inside the options objects at lines 37 and 83, never in an
  expectation.
- Therefore: if the raw mount is ever removed, reordered after `json()`, or its path drifts from
  the controller's, `req.body` silently becomes a parsed object, `Buffer.isBuffer` returns false,
  and **every delivery is answered 400 `missing_body`** — with a fully green test suite. That is
  the highest-blast-radius silent regression in this phase and there is no test standing on it.
- The provider's SDK documents the fix, verbatim, in `docs/WEBHOOKS.md` §"Test my handler in a
  unit test (no network)": `supertest` + `generateSignature` + `SIGNATURE_HEADER`, POSTed at the
  real route. No network, no key, no account. It was not used.

---

### F7 · **P2** · The tests re-implement the signing algorithm they are testing, so a wrong shared assumption passes both sides

`tango-webhook.spec.ts` · `function sign(body, secret) { return \`sha256=${createHmac('sha256', secret).update(body).digest('hex')}\` }`

The spec's `sign()` helper is a local re-derivation of the *same* assumption the implementation
encodes. It proves internal consistency, not interop. If the real scheme were
`HMAC(timestamp + '.' + body)`, or a different prefix, or a comma-joined multi-signature header
during secret rotation, **every test in this file would still pass and every real delivery would
401**. Using the SDK's `generateSignature` as the test's signer — one import, zero network —
converts the entire file from "consistent with itself" to "interoperable with the provider," and
would have surfaced F3 immediately.

This is the pattern D-57 named: *"a test shaped to make a claim pass, rather than shaped to check
whether the claim is true against realistic input."* The decision log records it recurring twice
in three fix rounds and calls the recurrence "more informative than either individual bug." It is
here a third time, in the file those rounds were fixing.

---

### F8 · **P3** · The 1 MB raw cap turns an oversized authenticated batch into a terminal 4xx

`configure-api-http-app.ts` line 136 · `raw({ type: '*/*', limit: '1mb' })`

The inline comment presents the cap as purely protective — *"an oversized body is refused by
express with a 413 before it reaches the controller."* But 413 is a 4xx, and under this
receiver's own retry contract a 4xx means *"stop retrying."* An oversized delivery is therefore
lost exactly as permanently as F1's, and never reaches a log line the receiver controls.

D-56 sizes this as *"a 3000-event batch of minimal event objects is ~152KB — comfortably inside
the webhook route's [limit]."* **"Minimal event objects" is the wrong input to size on.** The
SDK's documented event carries `matches: { new: [...], modified: [...], new_count, modified_count }`
— arrays of matched records, not ids. A broad alert (P47's design is deliberately broad — *"tell
us when any contract opportunity changes"*) firing on a busy day is not obviously under 1 MB.
Needs a real sizing against a real payload, or a larger cap plus an explicit 5xx-on-overflow.

---

### F9 · **P3** · The global rate limiter applies to the webhook route, undeclared

`app.module.ts` · `{ provide: APP_GUARD, useClass: ThrottlerGuard }`, `short` 30 req/s, `long` 600 req/min per IP

Neither `TangoWebhookController` nor any webhook controller carries `@SkipThrottle`
(`git grep SkipThrottle` over `apps/api/src/webhooks` → no hits), so the limiter governs
`/webhooks/tango`. A provider burst from one source IP gets `429`. Lower severity than F1/F8
because 429 is conventionally retried — but the controller's carefully written "status codes are
the retry contract" doc block enumerates 202/200/401/400/503 and does not mention that a sixth
status is reachable from outside it, and the in-memory per-task store means the effective limit
varies with task count.

---

### F10 · **P2** · `diag-tango-webhook-contract` has never been run, and the receiver has never been live — answering review question 5

The mandatory question: **every test in P46 has only ever run against synthetic fixtures. No real
provider payload has ever reached this code, and there is no live-verifiable success assertion.**
Verified four independent ways:

1. **No captured output exists.** `apps/api/src/external/tango/__fixtures__/real-captures/`
   contains exactly two files, both DIBBS/SBIR REST captures from 2026-08-09 (D-71). There is no
   webhook sample capture, and its own README enumerates what is there.
2. **The receiver is dark, structurally.** `infra/cdk/lib/config.ts` declares
   `externalSecretArns.tangoWebhookSecret?` at line 103 and **no environment assigns it**
   (`tangoApiKey` at line 300 is assigned; `tangoWebhookSecret` is not, anywhere). So
   `compute-stack.ts` never wires `TANGO_WEBHOOK_SIGNING_SECRET` onto the serve task, the service
   constructor reads `''`, and `receive()` returns `not_configured` → 503 for every request.
3. **No endpoint is registered with the provider.** The controller's own doc says so; the
   handoff's §6 table lists "Webhook endpoint + `capiro/dev/tango-webhook-secret`" as Neo's
   unstarted step, and lists running this diagnostic as step 1 of *"Suggested order when you have
   the key."*
4. **The diagnostic requires a key it has never had.** `probe()` exits `EXIT_NOT_CONFIGURED` (2)
   without `TANGO_API_KEY`; `diag-tango-webhook-contract.spec.ts` drives `compareContract` with
   hand-built `TangoWebhookSample` objects only.

The completion-matrix P46 row's live column reads *"Applied to `capiro-dev` 2026-08-08"* — that
is the **migration**, i.e. the table exists. It is not evidence that the receiver has verified
anything. A reader skimming that column could reasonably conclude otherwise; worth tightening
the wording.

---

### F11 · **P3** · A JSONB poison pill turns one authenticated delivery into an unbounded retry loop

`tango-webhook.service.ts` · `payload: parsed as never`

Postgres `jsonb` rejects `\u0000` inside a string. An authenticated payload containing one
(entirely possible in scraped federal text — this program's own `tango_notice_description_hash`
work exists because notice text is messy) makes the insert throw a non-`P2002` error, which is
correctly rethrown → `503` → the provider retries → fails identically, forever. Fails safe on
correctness (nothing is acknowledged unrecorded), fails open on availability, and produces an
`error` log per retry with no terminal state. A sanitize-or-quarantine path is needed.

---

### F12 · **P4** · `provider_event_at` will be null for the provider's documented single-event shape

`readEnvelope` reads body timestamps from `[occurred_at, occurredAt, timestamp, created_at]`.
The SDK's documented single-event body carries **`checked_at`**, which is not in that list.
Harmless today (the column is nullable and the replay window treats absence as acceptable), but
it means the column will be systematically empty for one of the two real shapes, and P47/P48
should not read anything into that.

---

## 4. Findings queue — for whoever picks this up

**Nothing in this review was fixed. This is the queue, not a changelog.**
Ordered by what must be resolved before the endpoint is registered with the provider.

| # | Sev | Item | Blocking? | Suggested resolution |
|---|-----|------|-----------|----------------------|
| F1 | P0 | No delivery id in either documented body shape → 400, permanent loss | **Registration-blocking** | Decide the id source against a real sample. Candidates: (a) confirm an `x-tango-delivery-id` header exists; (b) derive from `payload_sha256` + a body timestamp; (c) treat `missing_delivery_id` as **503, not 400**, so the provider retries while the contract is resolved. (c) is the cheap safety net and should land regardless. |
| F2 | P0 | Unique index keyed on an unsigned, undocumented header | **Registration-blocking** | Same decision as F1. If the header is the only id, the replay defence must not rest on it — key on a digest of the signed bytes, or add a signed-content component. |
| F3 | P1 | Bare-hex signature form rejected → 401, never retried | **Registration-blocking** | Accept both forms, matching the SDK's `parseSignatureHeader`; or delegate to the SDK's `verifySignature` via the `external/tango/` boundary. |
| F4 | P1 | SDK signing constants never asserted against | No | Add an offline test: `TANGO_SIGNATURE_HEADER === SIGNATURE_HEADER.toLowerCase()` and prefix parity. Correct the handoff §5 and the diagnostic's header comment — the header is SDK-corroborated, not plan-doc-only. |
| F5 | P2 | Diagnostic's `KNOWN_ID_KEYS` ≠ receiver's; shape check hardcoded `agrees: true` | No, but run it before trusting it | Derive the diagnostic's key list from the receiver's, not a parallel literal. Make the shape check able to fail. |
| F6 | P2 | No test on the real HTTP path / raw-parser mount | No | Supertest against `/webhooks/tango` through `configureApiHttpApp`, per the SDK's own documented recipe. Offline. |
| F7 | P2 | Tests re-implement the signing algorithm | No | Sign test payloads with the SDK's `generateSignature`. |
| F10 | P2 | Completion-matrix live column implies more than the migration proves | No | Reword to distinguish "migration applied" from "receiver never live". |
| F8 | P3 | 1 MB cap → terminal 413 | Before enablement | Size against a real `matches`-bearing payload; consider 5xx-on-overflow. |
| F9 | P3 | Throttler governs the webhook route, undeclared | No | `@SkipThrottle` or document the 429 in the retry-contract block. |
| F11 | P3 | `\u0000` → infinite 503 retry | No | Sanitize or quarantine on non-`P2002` insert failure. |
| F12 | P4 | `checked_at` not read as a body timestamp | No | Add to the candidate list. |

---

## 5. Verdict

```
P46_REJECTED
```

Failing checks by review question: **2** (idempotency key — F2), **3** (other envelope-shape
assumptions with #834's failure mode — F1, F3), **4** (test coverage of the real path and of
interop — F6, F7), **5** (no live assertion, fixtures only — F10). Question **1** (raw-bytes
ordering) **passes cleanly** and is the strongest part of this phase.

Approval would require F1, F2 and F3 resolved — they are not style disagreements. On the
provider's own published evidence, registering this endpoint today results in either every
authenticated delivery being answered 400 and lost forever (F1), or the replay defence resting
entirely on a header an attacker can set (F2).

**The most useful thing this review found is not any single defect.** It is that the two facts
P46 recorded as unknowable without a live key — the signature header and the delivery envelope
shape — were sitting in `node_modules/@makegov/tango-node/`, in a pinned dependency, in shipped
code and shipped documentation, readable offline in about ten minutes. The program correctly
identified the risk, correctly refused to guess, and then chose a mitigation (a live probe
requiring a credential nobody has) over one that was free, offline, and available the whole time.
D-35/D-41/D-42/D-45 established the rule *"do not write a sync against an unverified assumption."*
The corollary this review adds: **before declaring an assumption unverifiable, read the vendor
package you already depend on.**

---

## 6. Reproduction

Everything above is reproducible offline, without a MakeGov key.

```bash
# Read the code exactly as reviewed (read-only; does not touch the working tree)
cd C:/dev/capirov2
git show d800dcfde5:apps/api/src/webhooks/tango-webhook.service.ts

# The provider's own evidence
SDK=C:/dev/capiro-fo-ga-review-wt/node_modules/.pnpm/@makegov+tango-node@1.1.0/node_modules/@makegov/tango-node
cat  $SDK/dist/webhooks/signing.js          # SIGNATURE_HEADER, SIGNATURE_PREFIX, bare-hex acceptance
cat  $SDK/dist/models/Webhooks.d.ts         # WebhookSampleDelivery { timestamp, events } — no id
sed -n '180,220p;430,450p' $SDK/docs/WEBHOOKS.md   # both documented body shapes — no id in either
grep -rn "X-Tango-" $SDK/docs $SDK/README.md      # X-Tango-Signature only; no delivery-id header

# The delivery header exists only in Capiro's source
git grep -rn "x-tango-delivery-id" d800dcfde5

# Test subset (clean detached checkout at the pinned SHA)
cd C:/dev/capiro-fo-ga-review-wt/apps/api
./node_modules/.bin/jest --testTimeout=60000 \
  --testPathPattern "(tango-webhook|diag-tango-webhook-contract|configure-api-http-app)"
```

The *(executed)* results in F1, F2, F3 and F4 came from a throwaway `tsx` script that imported
P46's exported `readEnvelope` / `verifyTangoSignature` alongside the SDK's `generateSignature` /
`verifySignature` and ran them against the SDK's documented payloads. It performed no network
call, no database access and no write, and was deleted after use.
