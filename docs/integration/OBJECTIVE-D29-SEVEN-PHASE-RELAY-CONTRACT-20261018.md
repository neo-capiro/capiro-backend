# Objective D29: seven-phase credential relay and authority contract proposal

Status: **cross-repository source proposal with a bounded issue-request parser and caller-proof boundary; no enabled receiver or runtime grant.**
Source comparison: Core PR86 `f64047ac9dff328a56e5409869b38e90dff7ef98`;
Meri PR157 `bf8d215f519d1e397922f340922c777fa381e088` (its
`apps/control/objective-generation/core-http.mjs` blob is `c2d10f4d`, unchanged
from the 8e7bf0e8 handover). This packet covers the seven generation-worker
phases. The separate terminal-accounting and Core-to-Meri retained-result
subjects are outside this relay.

## 1. Existing caller and Core facts

Meri's `core-http.mjs` calls `authorization.readCredential` before each
Strategy dispatch and again after reading its reply. Each callback currently
receives `{operation,phase,method,route,source,sourceSha256,requestSha256,
bodySha256,signal,deadlineMs}`. `source` is exactly
`{generationJobId,binding}`, with the complete seven-field `RunBinding`
`{tenantId,actorId,conversationId,runId,attemptId,workerId,writerFence}`.
`operation` is `objective.strategy.draft`. Meri accepts only this closed
13-field callback result:

`{credential,actorId,tenantId,generationJobId,operation,method,route,phase,
sourceSha256,requestSha256,bodySha256,checkedAtMs,expiresAtMs}`.

The second callback must return **identical credential bytes** and freshly
revalidate authority; a new token/JTI does not qualify. `actorId` in the echo
is the original Clerk actor string from Core's delegated native job, not Core's
UUID `actorUserId` and not an actor chosen by the Meri request. Meri checks the
echo against the full source and the current time, then returns only a bounded
unqualified Strategy response; `core-client.mjs` has closed phase decoders.

The hash domains are different:

- Meri `sourceSha256` is RFC 8785 SHA-256 of the *whole* `source`, including
  its seven-field binding.
- Meri `requestSha256` is RFC 8785 SHA-256 of
  `{schemaVersion:1,generationJobId}`.
- `bodySha256` is SHA-256 of the exact POST bytes
  `{"schemaVersion":1,"generationJobId":"<job UUID>"}` or SHA-256 of zero
  bytes for GET. All seven routes have an empty query.
- Core's generation-worker JWT `sourceSha256` claim is **null** for these seven
  Strategy phases. Core's issuance-request SHA-256 is over the exact relay
  body. Neither is Meri's `sourceSha256` or `requestSha256`.

Core's current `/api/internal/objective-workload-authority/decisions` is a
hard-disabled, admit-only **201** issuer with a four-field request and a
`{token,authorizationJti,iatSeconds,expSeconds}` response. It cannot be
substituted for the Meri `readCredential` echo. The existing pure
`objectiveAdmitCredentialEcho` validates only admit and is not mounted. The
later-phase kernel `decideObjectiveLaterCurrentWithinTx` is source-only and
has no production SQL/resource/Meri-owner adapters.

## 2. Fixed phase/target matrix

| Phase | Target used by Meri | Expected status | Core source of current authority |
| --- | --- | --- | --- |
| `admit` | POST `/strategy-api/internal/objective-canonical/generation-admissions` | 201 | Native queued job, current actor/membership/objective, canonical plan, consent/control and enabled delegation; original admission target body. Existing admit issuer source exists but is disabled. |
| `admission-read` | GET `/strategy-api/internal/objective-canonical/generation-admissions/:generationJobId` | 200 | Core-owned admission resource and deterministic job marker, current native actor/membership and unrevoked delegation. A missing acceptance value is not proof that no acceptance effect occurred. |
| `publish` | POST `/strategy-api/internal/objective-canonical/generation-requests` | 201 | Admission, queued original job, current effect consent/control, unrevoked delegation, typed request and prompt derived from the original Core job. |
| `request-read` | GET `/strategy-api/internal/objective-canonical/generation-requests/:generationJobId` | 200 | Persisted immutable publication, original admission, current native actor/membership and unrevoked delegation. |
| `accept` | POST `/strategy-api/internal/objective-canonical/generation-acceptances` | 201 | Publication plus an independently authenticated **original Meri ISSUED** run/receipt and complete seven-field accepted binding, compared to the Strategy acceptance. Current Core effect consent and original run expiry still apply. A Strategy echo or matching SHA alone is insufficient. |
| `complete` | POST `/strategy-api/internal/objective-canonical/generation-completions` | 201 | Same original Meri run and persisted acceptance; Core job must be the claimed running attempt with the expected issuance key, current effect consent and source deadlines. Core must read the retained typed result through its separate authenticated reader before saving the completion. |
| `completion-read` | GET `/strategy-api/internal/objective-canonical/generation-completions/:generationJobId` | 200 | Persisted completed receipt, completed Core job, original accepted Meri binding, current native actor/membership and unrevoked delegation. |

The route, method, phase, empty query and target-body SHA are independently
constructed by Core for the selected phase. Caller JSON, a signed bearer, a
Strategy resource or a Core admission digest alone does not supply authority.
Core's later-phase decision kernel provides the phase distinction and compares
the original Meri readback, but the concrete adapters and relay remain absent.

## 3. Proposed issue wire and proof

Add a distinct `POST /api/internal/objective-workload-authority/credentials`,
without changing `/decisions`. Capture the original entity, refuse repeated
Authorization fields, queries, content-type ambiguity and bodies over **4096
bytes**, and require the exact outer JSON key order below. `signal` and
`deadlineMs` are transport controls and never signed JSON fields.

```json
{"schemaVersion":1,"operationId":"<UUID>","generationJobId":"<UUID>","phase":"<one of seven>","method":"POST|GET","route":"<fixed phase path>","source":{"generationJobId":"<same UUID>","binding":{"tenantId":"<UUID>","actorId":"<Clerk actor>","conversationId":"<UUID>","runId":"<UUID>","attemptId":"<UUID>","workerId":"<UUID>","writerFence":1}},"sourceSha256":"<lowercase hex64>","requestSha256":"<lowercase hex64>","bodySha256":"<lowercase hex64>"}
```

The source binding is exactly those seven fields, with no hidden inputs.
Core independently loads the job/delegation and compares every field to the
original accepted binding where applicable. Core recomputes all three Meri
hashes and the phase target; it never copies a claimed hash into a JWT claim.

`Authorization: Bearer <RS256 caller proof>` has the existing
`capiro-objective-workload-proof+jwt` exact header and the fixed
`capiro:objective-core-issuer:v1` audience. Its `method=POST`, `path` is the
new credentials path, `query=''`, `bodySha256` covers the **captured raw relay
bytes**, and `operationId` equals the body. The pinned `(kid,issuer,subject,
RSA public key >=3072 bits)` names only
`capiro-objective-generation-worker:v1`. The proof lifetime remains at most
30 seconds. The new path needs an explicit verifier target; a proof bound to
the old `/decisions` path must fail here. Proof verification precedes global
job-to-tenant routing, and the tenant transaction records a unique
`(callerIssuer,proofJti)` use. Every callback presents a **fresh proof JTI**;
the operation ID and exact issue body remain stable for one dispatch.

For `admit`, `publish`, `accept` and `complete`, define a deterministic effect
operation ID from the original job and phase, so a process restart cannot
silently claim a second effect token. Proposed derivation: SHA-256 of UTF-8
RFC 8785 JSON `['capiro.objective.workload.operation.v1',generationJobId,
phase]`; take the first 16 bytes, set UUID version bits to 8 and variant bits
to RFC 4122 `10`, then format lowercase. Core must recompute and compare this
value. Golden vector: job `00000000-0000-4000-8000-000000000001`, phase
`admit` -> `c866242a-2fce-8d93-aace-1d84475a3ddf`. For each GET dispatch,
Meri may allocate a fresh UUIDv4; that UUID is
held across its two callbacks, while a later independent read may use a new
UUIDv4. `core-http.mjs` therefore needs to pass `operationId` from `send()`
into both `readCredential` calls. Reusing a proof JTI, changing the issue body
for one operation ID, or allocating a new effect operation ID must fail.

The first successful response is HTTP **200**, JSON and `no-store`, with the
exact 13 Meri echo fields above. `credential` is the just-issued Core RS256
JWT; `checkedAtMs` comes from Core's trusted current check and
`expiresAtMs` is the issued token expiry in milliseconds, clipped by native,
delegation, consent and original effect deadlines as applicable. Core's durable
issuance row and `authorizationJti` are the single source of token identity;
the echo is a presentation, not an additional grant. Unknown, semantic denial,
missing owner data and uncertain delivery produce a nondisclosing 503 with no
credential. The existing `/decisions` 201 response shape is unchanged.

## 4. Release recheck and uncertain effects

The second `readCredential` callback occurs **after** the Strategy response.
Simply calling the issue path again is insufficient for `accept` and
`complete`: Core's current effect predicate requires a queued or running job,
respectively, and a legitimate effect may already have changed that state.
The Meri port must distinguish `issue` from `release`, pass the first token's
identity on release, and return the original token bytes only after Core
revalidates it. Proposed extension to the in-process call:

- `issue`: the ten signed JSON fields in §3, before dispatch;
- `release`: the same ten fields plus the original `authorizationJti` and
  `credentialSha256`, after response capture. The adapter retains the first
  credential locally; the `core-http.mjs` echo stays the same closed 13 fields.

Use a separate proof-bound `POST
/api/internal/objective-workload-authority/credentials/revalidate` for release.
Its body starts with the same ten fields in the same order, then
`authorizationJti,credentialSha256`; Core recomputes the first ten-field issue
body SHA, verifies the saved immutable issuance/delivery, exact token digest,
phase, target, tenant, job and JTI, and rechecks the native actor, membership,
delegation and phase's persisted result under the appropriate locks. It does
**not** sign or allocate another JTI. The successful release response contains
the original JTI/digest plus the twelve noncredential echo fields; the Meri
adapter compares it and returns the locally retained original credential in
the 13-field echo. This separate release shape needs both owners' review before
source implementation; the §3 decoder alone does not provide release safety.

Core's existing migration has a unique issued effect claim per
`(tenant,job,phase)` and the issuer refuses a saved token after its maximum
60-second expiry. Meri's `lifecycle-driver.mjs` currently retries
`source` (admit + publish) every **120 seconds** after an unconfirmed effect,
and `lifecycle-activities.mjs` repeats both POST calls. That cannot obtain a
new effect token. After any uncertain or expired effect, the owner must use
the matching read phase to reconcile the original job. In particular:

- unknown `admit` -> `admission-read`, and unknown `publish` ->
  `request-read`, before any further effect decision;
- unknown `accept` -> the acceptance value inside `admission-read` (there is
  no standalone acceptance GET in Meri's seven-call transport);
- unknown `complete` -> `completion-read`; a missing/undecodable reply never
  proves absence or permits a second completion claim.

Meri's activity/client retry semantics and Core's post-effect release checks
must be implemented together. A fresh proof JTI is caller replay protection;
it is **not** permission to mint a fresh effect authorization JTI.

If a read under the original job lock establishes that no effect occurred but
the one effect token has expired, the current unique claim still cannot issue
a replacement. That case must end as a definite unavailable outcome, or the
owners must separately specify a transactionally fenced no-effect witness and
versioned reauthorization rule. An HTTP miss, timeout or absent Meri reply is
never that witness. The present Meri 120-second source retry cannot be called
a live recovery path while this liveness rule is unresolved.

## 5. Concrete source and external binding sequence

1. Core source now has the bounded `/credentials` raw capture, exact ten-field
   issue decoder, seven-phase target/hash checks, deterministic effect ID
   check, and new-path named caller-proof verifier in
   `objective-credential-relay-{request,ingress}.ts`. The proof JTI is **not**
   consumed by this parser, no `/credentials` controller is mounted, and no
   native issuer or post-effect release owner is bound. The production
   admission provider remains closed.
2. Meri: pass a stable operation ID into both callback invocations, add an
   explicit release callback with the original token identity, and change
   uncertain-effect retry to read reconciliation. Wire the missing `accept`
   lifecycle step against the genuine ISSUED run; the current Objective
   activities call admit/publish and complete but do not call `client.accept`.
3. Core and Meri: define the signed, original Meri accepted-run readback
   (seven-field binding, issuance/grant, protected full facts and custody)
   independently of Strategy's echoed acceptance. Core implements the
   later-phase SQL/resource adapters in the existing lock order and the
   phase-specific post-effect release check. Meri composes `clientFor`, the
   one-run `runs.start/read` owner and the protected-facts association.
4. Core: extend issuer and persistent claim handling to all seven phases
   without relaxing the unique effect claim, prove exact-token/JTI replay and
   post-effect release, and wire the 13-field echo. Both repositories run
   focused cross-repo vectors for all seven targets, proof replay, expiry,
   revocation, lost replies and state changes between issue and release.
5. Activation only after the Objective delegation fence decision/migration,
   pinned policy revision, Core RS256 issuer private key, Meri RSA >=3072
   caller-proof public pin, native/Strategy role readback, Meri accepted-run
   owner, retained-result reader-v2 key/JTI store, Temporal activity/runner
   composition and exact image/config qualification. None of these bindings
   is supplied by this document or the source-only decoder.

Core's current admit runtime remains disabled and the delegation migration
still enforces `CHECK(enabled=false)`. This proposal neither grants Objective
authority nor changes any live key, database, role, service or route.
