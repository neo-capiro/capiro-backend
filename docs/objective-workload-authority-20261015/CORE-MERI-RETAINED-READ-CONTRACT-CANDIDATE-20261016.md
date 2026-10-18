# Core–Meri Objective retained-read token candidate

**Status: source-only candidate for joint Core/Meri qualification.** Core's
`apps/api/src/auth/workload-authority/objective-workload-jwt.ts` now implements
the flat RS256 wire below. Meri draft PR #95 at
`5781c1150fbb3954c25ba245b26d325e06b4d82d` implements an unmounted
RS256 retained reader. The adjacent unsigned vectors and public-only signed
fixture pin that Meri source. Core producer/crypto checks passed 76/76, and a
task-owned offline run against the exact Meri PR #95 source passed 63/63
expected allow/deny outcomes and current, replay, and owner callback counts.
That run used synthetic current authority and an in-memory replay port; the
public Meri gate does not expose its internal rejection-stage labels. Neither
retained-read route nor issuer is mounted, and no product key, credential,
trust manifest, replay store, live route, SQL execution, or deployment was
allocated by these fixtures. Ordinary authenticated chat remains separate.

## One proposed Core-issued authorization

Core owns issuance. The header is exactly the compact UTF-8 JSON object
`{"alg":"RS256","typ":"capiro-objective-workload+jwt","kid":"<pin>"}`
in that order. `kid` is a configured `[A-Za-z0-9._-]{1,64}` identifier for a
locally pinned RSA public key of at least 3072 bits. The receiver accepts
only RSASSA-PKCS1-v1_5 with SHA-256 and a fixed issuer/key mapping. It never
uses token-supplied keys, `jwk`, `jku`, `x5u`, URLs, or an ambient JWKS fetch.
The published fixture retains no private key. Its issuer and `kid` are synthetic pins;
deployment must allocate environment-qualified values separately.

The retained-read payload is a **closed flat object**, in this fixed Core
serialization order:

```text
iss, sub, aud, iat, nbf, exp, jti,
method, path, query, bodySha256, operation, phase,
tenantId, generationJobId, delegationRef, consentId,
attemptId, runId, acceptedBindingSha256, sourceSha256
```

The first 20 members and their order came from Core's earlier fixture.
`sourceSha256` is the implemented twenty-first member. A future mounted Core
adapter must derive it from the independently resolved complete source, not
accept a caller's digest. These are the retained-read values:

| Claim | Proposed exact value or check |
| --- | --- |
| `iss` | Environment-qualified, configured Core reader issuer. The synthetic vector uses `urn:capiro:objective:core-reader-issuer:v1`. |
| `sub` | `capiro-objective-core-result-reader:v1` only. |
| `aud` | `capiro:objective-meri-retained-result:v1` only. |
| `iat`, `nbf`, `exp` | Safe integer Unix seconds, `iat <= now`, `nbf >= iat`, `nbf <= now`, `exp > now`, `1 <= exp-iat <= 60`; Core also clips to current source and request deadlines. No fixture clock skew extends a database fence. |
| `jti` | Fresh random UUIDv4, unique for the durable issuance intent. The Core helper now enforces UUIDv4. An exact issuer replay reproduces the original still-current signed token and `jti`. |
| `method`, `path`, `query` | `POST`, `/v1/internal/objective-generation/retained-result/read`, `""`. No rewritten path, query, redirect or alternate encoding. |
| `bodySha256` | Lowercase SHA-256 of the exact received raw UTF-8 entity bytes. The receiver hashes before any JSON reserialization. |
| `operation` | `objective.retained-result.read` only for `retained-result-read`. The underlying Core delegation's `work_action` remains `objective.strategy.draft`; a read token is never an effect grant. All Strategy phases keep `objective.strategy.draft`. Core implements this mapping but does not authorize later-phase issuance. |
| `phase` | `retained-result-read` only. Strategy/terminal tokens cannot enter this receiver even if correctly signed. |
| `tenantId`, `generationJobId` | Lowercase UUIDs matching the trusted accepted source and native tenant. |
| `delegationRef`, `consentId` | Lowercase Core UUIDs. Meri may not use these signed values as their own current authority; its `assertCurrent` port must corroborate original Core delegation/consent and current source or fail closed. |
| `attemptId`, `runId` | Non-null lowercase UUIDs equal to the trusted accepted run's attempt and run. |
| `acceptedBindingSha256` | `generationBindingKey(parseAcceptedRunBinding(fullBinding))`, over **all seven** accepted-binding members: tenant, actor, conversation, run, attempt, worker, writer fence. It is not a hash of only run/attempt and is not `sourceSha256`. |
| `sourceSha256` | `canonicalSha256({generationJobId,binding,sourceAdmissionSha256})`, including the full binding and saved source-admission hash. It must equal Meri's digest of its fixed trusted source and of the closed parsed request source. |

The Meri request remains `POST` with the closed body
`{"schemaVersion":1,"source":{"generationJobId":...,"binding":...,"sourceAdmissionSha256":...}}`.
The body has at most 65,536 bytes under the shared source contract, and its
exact bytes must match `bodySha256`. The Core JWT helper enforces this
phase-specific cap. Neither its source nor the signed token chooses an
arbitrary result owner. Before admission, Meri resolves the accepted run from
trusted custody, constructs a fixed gate for its exact source and retained
owner, and checks the native actor, membership, consent/delegation, source,
and retained custody again before and after `runOnce`. Any absent current
authority port keeps the Objective gate unavailable.

The two digest conventions must remain distinct. `sourceSha256` uses Meri's
`canonicalSha256(source)` backed by `canonicalize` 5.1.0; the canonical source
object contains only `binding`, `generationJobId`, and
`sourceAdmissionSha256`, **not** the outer `schemaVersion`. Its inner binding
has `actorId`, `attemptId`, `conversationId`, `runId`, `tenantId`, `workerId`,
and `writerFence` in sorted-key order. `sourceSha256` is **not** the hash of
the raw body, nor a digest accepted from that body. The receiver parses the
closed body only after checking its independent signed raw-byte digest,
then computes the source digest and compares the parsed source to its fixed
trusted source. `acceptedBindingSha256` uses Core
Strategy's `generationBindingKey(parseAcceptedRunBinding(binding))`. For this
finite string/integer fixture domain both are represented by sorted-key
compact JSON and SHA-256, but Core and Meri must independently reproduce the golden
values in `CORE-MERI-RETAINED-READ-VECTORS-20261016.json` before freezing the
contract. The stored `sourceAdmissionSha256` is itself source evidence, not
a substitute for checking the saved admission. The issuer may not copy an
untrusted request's source or SHA fields into claims without comparing the
original job, accepted run, consent/control, membership and custody.

## Receiver and replay checks

Meri PR #95 replaces the prior unmounted EdDSA/nested verifier with this
RS256/flat form. It must reject duplicate or extra header/payload members, noncanonical
base64url, invalid UTF-8, wrong fixed serialization, malformed or oversized
segments, unknown/stale `kid`, wrong signature, and algorithm/type confusion.
Preserve the 8,192-character token cap, 1,024-byte header cap, 4,096-byte
payload cap and 4,096-character signing-input cap. Core's helper now enforces
the same segment/signing-input bounds.

After signature and raw wire checks, Meri compares every claim to independent
expected route, configured issuer/subject/audience, fixed trusted source,
accepted binding, current actor/membership, Core delegation/consent and
retained custody. `tenantId` is only a routing hint until checked against
trusted rows. A signed but stale grant remains denied. `runOnce` is durable,
keyed by `(iss,sub,jti)`, and compares the exact signed-token SHA-256 plus
method/path/query/body/source/job, accepted binding and selected owner. It
returns the prior immutable result for byte-identical current replay, rejects
changed replay, and leaves pending or uncertain work unavailable. No second
callback executes for one identity. Current authority and owner readiness are
rechecked before releasing a replayed result. These ports are missing; the
source-only gate stays unmounted.

Core's caller proof is a **different** credential to `POST
/api/internal/objective-workload-authority/decisions`: RS256, custom
`typ=capiro-objective-workload-proof+jwt`, separate pinned caller issuer/key,
`aud=capiro:objective-core-issuer:v1`, maximum 30-second lifetime and exact
raw issuance-body binding. It is never forwarded to Meri. Meri CONTROL's
The earlier PR #90 Ed25519 issuer/KMS proposal cannot be silently treated as this proof;
its signer/custody and exact response contract need a separate joint decision.
Keep the Meri source same-token pre-dispatch/post-reply recheck, durable
CLAIMED/ISSUED/UNKNOWN semantics, and no fresh `jti` after an uncertain
signing or delivery result. The proposed authorization says nothing about
KMS versus an allocated Core signer; production key custody is unresolved.

## Offline matrix

The adjacent unsigned JSON contains a baseline and path-based synthetic
mutations. `CORE-MERI-RETAINED-READ-SIGNED-FIXTURES-20261016.json` contains
their signed bytes and a synthetic RSA-3072 public pin; its private key was
discarded. Core checks its producer and cryptography against those bytes.
The task-owned cross-repository harness ran the same 63 tokens and raw bodies
through PR #95's gate with synthetic current authority, replay and owner
ports, including malformed signatures. Its sanitized result is retained at
`task-3/meri-pr95-retained-signed-results.json`. Product durable replay,
current authority wiring and live ingress remain unqualified. No fixture
token or key is usable as a product credential.

The same-`jti`, changed-fingerprint case first completes one accepted read, then
re-signs the **same** `jti` with `exp=1800000029` at fixture time
`1800000000`. Both lifetimes are valid, so the second denial must come from
the durable replay fingerprint check, with no second result-owner callback.
For each malformed or stale case, assert the rejection stage and replay-store
and owner callback counts in the JSON, not just its public error. Check the
wire size limits before decoding or signature work; body size before hashing.
Run separate `UNKNOWN` cases before and after an owner callback and deny a
later identical replay without another owner callback. These are required
harness behaviors; the offline run checked outcome and callback counts, while
the public gate did not expose named internal rejection stages.

Positive vectors: baseline current read; exact replay returns one saved
result; current revocation after read begins withholds the reply. Negative
vectors: old EdDSA/nested layout; wrong type, key, issuer, audience, subject,
operation, phase, route, method or query; exact body whitespace change;
wrong source-admission hash, job, tenant, actor, conversation, run, attempt,
worker or writer fence; wrong independent binding/source digests; future or
expired clocks, non-v4/reused `jti`; unknown source/owner, unavailable
current check, and changed or uncertain replay. Test that mutation of a
trusted source with **correctly recomputed** body and source digests still
fails the fixed-source and current-authority checks.

Sources: Core `objective-workload-jwt.ts` and Strategy
`objective-canonical-generation.ts`/`objective-canonical-retained-http-bridge.ts`
on draft PR #42; Meri PR #95 `workload-reader-gate.mjs` and its focused test
at `5781c1150fbb3954c25ba245b26d325e06b4d82d`.
