# Core signed memory page source composition, unmounted

Base: Core build packet `03796805255a285d486d4bc912a899f45244e8b5`.

`readTaskBoundPassiveMemoryPage` composes the prepared `search_memory@0.2.0` admission with Core's existing canonical `search_memory` reader. It accepts only a middleware-owned, already consumed Option B tool grant and authenticated signed correlation. The middleware now carries the token's checked exact emitted-body SHA-256 into that request-local grant; missing bytes/hash refuse this page. The read is pinned to the selected client, original ADMITTED binding, argument hash and current grant expiry. After the canonical owner read, it snapshots the unmodified bounded JSON page, derives the same canonical result and per-record hashes that Meri's current client-knowledge adapter derives, and invokes a supplied delegated pre-byte release recheck. It refuses duplicate/invalid record IDs, an oversize page, changed delegation or expiry during the read/release. The result and helper correlation are returned separately so an eventual route cannot mistake a hash for authorization.

The initial page function remains source preparation only: no controller calls it, and `search_memory` is still absent from Core's delegated token allowlist. Its supplied release callback must be Core's actual `assertMeriReadDelegationReleasable`, not an assertion in a request body. The helper correlation is **not** a credential or eligibility receipt and cannot release content. The successor below allocates a distinct one-use helper child bound to the parent and original grant; it never issues a second ordinary `tool` token or increases `READ_TOKEN_CEILINGS.tool = 1`.

Meri PR #157 `ab83ee97e9cb88b4727291284da9e2485157c309` still supplies an ordinary native Bearer and service secret for its memory page and eligibility callback; it does not forward the trusted invocation/call key or a signed helper token. Its adapter checks a receipt's expiry locally, but the final dispatcher release after authorization, retention and settlement does not yet enforce that expiry. The Meri owner must carry the exact receipt through final release and refuse when `now >= expiresAtMs`. The separate `memory.list_own_proposals@0.2.0` versioned target or signed alias remains absent; its prepared Core producer is not mounted. Personal passive recall remains held. These are runtime source dependencies, not deployment toggles.

The successor Core helper source follows the **two-step** target in backend
PR88 comment 6252628690. `issueMemoryPageProof` signs an opaque, non-authorizing
`x-meri-memory-page-proof` for the unchanged 0.2 page after checking the
consumed parent row, original UNKNOWN reservation and ADMITTED binding under
the snapshot lock. Meri validates that page and sends one closed
`memory_eligibility` request to the existing `/read-delegations/:id/tokens`
service endpoint. `issueMemoryHelperToken` verifies the proof and parent again,
then inserts one child of the consumed parent into the existing token table.
The 100000 source migration adds a helper kind, parent link, exact page/result/
callback hash pins and unique `(run_id,call_key)` and parent-JTI indexes, with
no new grant or change to `tool_tokens <= 1`. The helper uses the existing
`CapiroMeriRead` scheme with distinct JWT type/audience and a fixed internal
target. `consumeTaskBoundMemoryHelper` checks signed correlation, exact raw
callback bytes, parent/UNKNOWN/ADMITTED facts, current consent/member/client
and governed memory rows before issuing a receipt; its own release recheck
refuses expiry or drift. An ordinary read token cannot parse as a helper.

These issuer and receiver functions are **unmounted**. The existing `/tokens`
controller still uses the four-kind parser, and the ordinary middleware would
reject a helper JWT before a route could run. A shared HTTP owner must add the
fixed helper branch, capture its exact 16 KiB raw body, send only the unchanged
page plus proof header, and recheck before any byte. Meri must publish the
matching signed transport and enforce receipt expiry at final dispatcher
release. The source-only `100000` migration cannot execute while the earlier
`090000` release stop remains; no SQL, AWS, new credential, grant, provider,
route or model call was made here. Personal recall remains closed.

Focused memory page and helper tests: 14/14; scoped TypeScript on ten touched
source/test files: zero diagnostics.
