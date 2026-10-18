# Held Core signed memory HTTP composition (2026-10-18)

Base: integrated Core source `1f45da20fcbedcf5befb13d225428b8119443a68`.
Counterpart: draft Meri PR172 `432006eb2b1d87af8c73e11d4222be2a5930952b`.

The `search_memory@0.2.0` signed page now has an explicit Core HTTP owner
branch. It accepts the existing one-use `CapiroMeriRead` tool token, original
ADMITTED run and UNKNOWN reservation through the ordinary middleware, then
passes the request-local grant and authenticated correlation to the passive
page source. On qualified release it returns the unchanged 0.2 JSON result
and places the opaque proof in `x-meri-memory-page-proof`, not in the body.
The canonical owner and delegated release checks remain in series before
bytes are returned.

The existing service-only `/read-delegations/:id/tokens` controller recognizes
the distinct `memory_eligibility` request and calls the separate child issuer.
The fixed `POST /api/clio/tools/search_memory_eligibility` controller receives
the exact 16 KiB UTF-8 entity captured by the existing raw-body middleware.
`MeriModule` registers that literal controller before `MeriController`'s
dynamic `tools/:name` route; the dynamic branch also refuses the helper name.
Its distinct signed token bypasses the ordinary read-token parser only on the
exact fixed route, then the receiver verifies service identity, signature,
correlation, consumed parent and one-use child, original run binding, current
consent/member/client visibility and a pre-byte release check. The ordinary
`tool` token ceiling remains one; the helper uses a separate existing-table
kind. The original `current_admission_v1` lock and ADMITTED operation set are
unchanged.
The shared pre-byte transaction now rechecks the original UNKNOWN reservation
for the exact page and proposal operations before either result is released.

The exact dotted `memory.list_own_proposals@0.2.0` alias branches before the
ordinary tool allowlist and sends its authenticated grant, correlation and
service marker to the PR172 receiver. That receiver uses the canonical
`GovernedMemoryCandidateService` owner and calls the same delegated release
transaction after validating the result. The alias is excluded from ordinary
model tool discovery and remains hard disabled before token mint and consume.

Both page and helper routes are **hard disabled in source**. The source gate
has no environment activation. It refuses `search_memory@0.2.0` before
ordinary token minting and before middleware consumes its JTI; the helper
issuer and fixed callback return 503 before any database action. The dynamic
ordinary tool route also refuses the helper name. Proposal alias dispatch has
its own source-only hard-off decision. None of these changes makes passive
memory reads available on a deployed runtime.

Activation requires review of the matching Meri wire, the held Core `100000`
helper migration and target role, source image/config identity, signed relay,
and runtime readback. The `100000` migration remains outside this integrated
Stage1 tree. No SQL, AWS, new credential, grant, paid provider or live call was
performed for this composition.
