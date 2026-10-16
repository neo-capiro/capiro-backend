# Core–Meri Objective retained-read token candidate

**Status: source proposal for joint Core/Meri review.** The Core fixture at
`apps/api/src/auth/workload-authority/objective-workload-jwt.ts` and Meri draft
PR #90 at `5b166bf49bf4871138e3c02eebf04a8d6f04a5e2` do not implement the
same wire contract. Neither retained-read route nor issuer is mounted. This
document and the adjacent unsigned vectors allocate no key, credential,
trust manifest, replay store, live route, SQL execution, or deployment. They
do not change either implementation. The extra flat `sourceSha256` and
phase-specific read `operation` remain pending parent and Meri review.
Ordinary authenticated chat remains
separate from this Objective gate.

## One proposed Core-issued authorization

Core owns issuance. The header is exactly the compact UTF-8 JSON object
`{"alg":"RS256","typ":"capiro-objective-workload+jwt","kid":"<pin>"}`
in that order. `kid` is a configured `[A-Za-z0-9._-]{1,64}` identifier for a
locally pinned RSA public key of at least 3072 bits. The receiver accepts
only RSASSA-PKCS1-v1_5 with SHA-256 and a fixed issuer/key mapping. It never
uses token-supplied keys, `jwk`, `jku`, `x5u`, URLs, or an ambient JWKS fetch.
The fixture uses no private key. Its issuer and `kid` are synthetic pins;
deployment must allocate environment-qualified values separately.

The retained-read payload is a **closed flat object**, in this fixed Core
serialization order:

```text
iss, sub, aud, iat, nbf, exp, jti,
method, path, query, bodySha256, operation, phase,
tenantId, generationJobId, delegationRef, consentId,
attemptId, runId, acceptedBindingSha256, sourceSha256
```

The first 20 members and their order come from the current Core fixture.
`sourceSha256` is the proposed twenty-first member; Meri PR #90 currently
requires that value inside its nested `objective` object. Core must derive it
from the independently resolved complete source, not accept a caller's
digest. These are the retained-read values:

| Claim | Proposed exact value or check |
| --- | --- |
| `iss` | Environment-qualified, configured Core reader issuer. The synthetic vector uses `urn:capiro:objective:core-reader-issuer:v1`. |
| `sub` | `capiro-objective-core-result-reader:v1` only. |
| `aud` | `capiro:objective-meri-retained-result:v1` only. |
| `iat`, `nbf`, `exp` | Safe integer Unix seconds, `iat <= now`, `nbf >= iat`, `nbf <= now`, `exp > now`, `1 <= exp-iat <= 60`; Core also clips to current source and request deadlines. No fixture clock skew extends a database fence. |
| `jti` | Fresh random UUIDv4, unique for the durable issuance intent. This tightens Core's current generic UUID parser to retain PR #90's UUIDv4 rule. An exact issuer replay reproduces the original still-current signed token and `jti`. |
| `method`, `path`, `query` | `POST`, `/v1/internal/objective-generation/retained-result/read`, `""`. No rewritten path, query, redirect or alternate encoding. |
| `bodySha256` | Lowercase SHA-256 of the exact received raw UTF-8 entity bytes. The receiver hashes before any JSON reserialization. |
| `operation` | **Proposed change:** `objective.retained-result.read` only for `retained-result-read`. The underlying Core delegation's `work_action` remains `objective.strategy.draft`; a read token is never an effect grant. All Strategy phases keep `objective.strategy.draft`. This phase-specific operation needs an explicit Core change and joint approval. |
| `phase` | `retained-result-read` only. Strategy/terminal tokens cannot enter this receiver even if correctly signed. |
| `tenantId`, `generationJobId` | Lowercase UUIDs matching the trusted accepted source and native tenant. |
| `delegationRef`, `consentId` | Lowercase Core UUIDs. Meri may not use these signed values as their own current authority; its `assertCurrent` port must corroborate original Core delegation/consent and current source or fail closed. |
| `attemptId`, `runId` | Non-null lowercase UUIDs equal to the trusted accepted run's attempt and run. |
| `acceptedBindingSha256` | `generationBindingKey(parseAcceptedRunBinding(fullBinding))`, over **all seven** accepted-binding members: tenant, actor, conversation, run, attempt, worker, writer fence. It is not a hash of only run/attempt and is not `sourceSha256`. |
| `sourceSha256` | `canonicalSha256({generationJobId,binding,sourceAdmissionSha256})`, including the full binding and saved source-admission hash. It must equal Meri's digest of its fixed trusted source and of the closed parsed request source. |

The Meri request remains `POST` with the closed body
`{"schemaVersion":1,"source":{"generationJobId":...,"binding":...,"sourceAdmissionSha256":...}}`.
The body has at most 65,536 bytes under PR #90, and its exact bytes must
match `bodySha256`. The Core issuer must enforce this same phase-specific cap;
its current generic JWT helper permits larger bodies. Neither its source nor the signed token chooses an
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

Meri must replace, version and review its unmounted EdDSA/nested verifier to
consume this RS256/flat form; simply relaxing its current parser would be
unsafe. It must reject duplicate or extra header/payload members, noncanonical
base64url, invalid UTF-8, wrong fixed serialization, malformed or oversized
segments, unknown/stale `kid`, wrong signature, and algorithm/type confusion.
Preserve PR #90's 8,192-character token cap, 1,024-byte header cap, 4,096-byte
payload cap and 4,096-character signing-input cap. Core's current fixture
needs the same segment/signing-input bounds before this becomes shared.

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
PR #90 Ed25519 issuer/KMS proposal cannot be silently treated as this proof;
its signer/custody and exact response contract need a separate joint decision.
Keep the PR #90 same-token pre-dispatch/post-reply recheck, durable
CLAIMED/ISSUED/UNKNOWN semantics, and no fresh `jti` after an uncertain
signing or delivery result. The proposed authorization says nothing about
KMS versus an allocated Core signer; production key custody is unresolved.

## Offline matrix

The adjacent JSON contains an unsigned baseline and path-based synthetic
mutations. A cross-repository harness should create a disposable RSA-3072
key pair, pin only its public key, sign each cryptographically valid mutated
payload, and run both Core issue/verify and Meri receiver fixtures against
the same raw bytes. It must separately exercise malformed signatures. No
fixture token or key is usable as a product credential.

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
on draft PR #42; Meri PR #90 `workload-reader-gate.mjs`, its focused test,
and `CODEX-MERI-OBJECTIVE-WORKLOAD-ISSUER-20261016.md` at the pinned head.
