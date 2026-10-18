# Core signed memory page source composition, unmounted

Base: Core build packet `03796805255a285d486d4bc912a899f45244e8b5`.

`readTaskBoundPassiveMemoryPage` composes the prepared `search_memory@0.2.0` admission with Core's existing canonical `search_memory` reader. It accepts only a middleware-owned, already consumed Option B tool grant and authenticated signed correlation. The middleware now carries the token's checked exact emitted-body SHA-256 into that request-local grant; missing bytes/hash refuse this page. The read is pinned to the selected client, original ADMITTED binding, argument hash and current grant expiry. After the canonical owner read, it snapshots the unmodified bounded JSON page, derives the same canonical result and per-record hashes that Meri's current client-knowledge adapter derives, and invokes a supplied delegated pre-byte release recheck. It refuses duplicate/invalid record IDs, an oversize page, changed delegation or expiry during the read/release. The result and helper correlation are returned separately so an eventual route cannot mistake a hash for authorization.

The initial page function remains source preparation only: no controller calls it, and `search_memory` is still absent from Core's delegated token allowlist. Its supplied release callback must be Core's actual `assertMeriReadDelegationReleasable`, not an assertion in a request body. The helper correlation is **not** a credential or eligibility receipt and cannot release content. The successor below allocates a distinct one-use helper child bound to the parent and original grant; it never issues a second ordinary `tool` token or increases `READ_TOKEN_CEILINGS.tool = 1`.

The historical Meri PR157 bearer adapter is superseded by draft Meri PR172
`432006eb2b1d87af8c73e11d4222be2a5930952b` for signed source transport.
That source emits the two-step proof-header wire, exact `JSON.stringify` callback
order, signed proposal alias and final receipt-expiry narrowing. Its 76-operation
P2 source-only measurement is `eb7f0cd742728ac15c7f01f5bc7d01c42158120406ad8557986061fce3670660`.
Meri narrows callback `deadlineMs` by gateway authority, local request timeout
and validated parent tool-token receipt. Core's opaque proof deadline is an
upper bound from that parent token; the callback may expire earlier. The Meri
source is still a draft, not installed or runtime qualified. Core's separate
`memory.list_own_proposals@0.2.0` producer is unmounted. Personal passive
recall remains held.

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
release. Keep the source-only `100000` migration directory **out of the Stage1
deployment tree** until the preceding staged `090000` migration, target role,
Meri wire, PostgreSQL rehearsal and bounded DDL window are qualified. Its
local lock timeout is five seconds and statement timeout is 30 seconds. No SQL,
AWS, new credential, grant, provider, route or model call was made here.
Personal recall remains closed.

Focused memory page and helper tests: 20/20, including mocked transaction
rollback, duplicate issuance, one-use consume, and parent revocation; scoped
TypeScript on twelve touched source/test files: zero diagnostics.
