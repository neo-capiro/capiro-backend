# Core/Meri saved-history release decision (proposal, 2026-10-18)

Status: **source contract only; no route, grant, migration, or runtime activation**. Core base is backend PR96 `784b1c3a91eb6d78f16d92c42e71f05c12c5b5bb`. This proposal does not touch Meri PR180's pool work. The Meri source inspected here is `f265435c910555b63c5908b1f1f7546436cf8759`; the later whole-page retention fence reported by the integration owner must remain in place.

## Gap and owner

Meri's history store verifies the stored owner, scopes, and event lineage. Its history service currently checks Core currentness one conversation at a time; the product HTTP owner rechecks membership after the route returns. Those sequential observations cannot establish that the entire published page was authorized at one point. Core `/membership` covers the member and visible client roster, but its `membershipRevision` excludes conversation archive and prospect/portfolio scope. Core `/context` covers exactly one conversation and selected client. Neither is a final decision for a complete list or transcript.

Core owns the new **one-request history release decision**. Meri owns the candidate response, canonical store integrity, whole-page retention filtering/fence, exact subject projection, and published bytes. The decision is a read authorization observation, never a bearer, grant, reservation, or reusable capability. It covers `list` and `transcript` only; `next-turn` remains under its effect owner.

## Closed internal wire, version 1

`POST /api/clio/application-authority/history-release` accepts the already supported **native live-session Bearer** and the existing `standard_user` role gate. Do not add this path to `MERI_CONTROL_POST_PATHS`, mint a credential, or accept a service header as authority. The endpoint has `Cache-Control: no-store` and a bounded deadline. If the existing native relay cannot deliver that bearer, keep the route and Meri release call unavailable.

Request JSON (closed keys):

```json
{
  "schemaVersion": 1,
  "observationId": "00000000-0000-4000-8000-000000000001",
  "route": "list",
  "responseSha256": "<64 lowercase hex characters>",
  "subjects": [
    {
      "conversationId": "00000000-0000-4000-8000-000000000002",
      "clientId": "00000000-0000-4000-8000-000000000003",
      "scopes": [{"tenantId":"00000000-0000-4000-8000-000000000004","kind":"client","resourceId":"00000000-0000-4000-8000-000000000003","policyRevision":"pinned-policy"}]
    }
  ]
}
```

`route` is exactly `list` or `transcript`. `subjects` preserves the order of distinct conversations exposed by the final response; a transcript has exactly one, and an empty list has zero. Bound it to the public 100-item page ceiling. `clientId` is a lowercase UUID or null. Every scope has the existing closed Meri `Scope` shape, with no duplicate scopes. Core derives tenant/actor from the authenticated request, never from this body. Core verifies each subject against its current owned active conversation row, current client/wall and applicable prospect/research-portfolio owners. The supplied scope is a constraint to verify against those facts, not a grant. An unsupported scope kind or clientless conversation without a qualified owner adapter denies the entire response; do not silently drop it after this call.

Meri derives `subjects` from the **retention-filtered final response**, never from a caller-supplied list. Its history validator/store must ensure that transcript runs, events, pending turn, and conversation have the same owned scope lineage. Every externally visible conversation identifier, including `nextBefore`, must refer to an authorized subject in this vector; otherwise withhold the page or change the cursor design separately. Meri computes `responseSha256` over the exact UTF-8 response bytes it will emit. It must freeze those bytes before calling Core and emit **those same bytes** after success.

Core responds only on complete success with closed fields:

```json
{
  "schemaVersion": 1,
  "observationId": "<exact request UUID>",
  "route": "<exact request route>",
  "principal": {"tenantId":"<Core tenant UUID>","actorId":"<Core actor UUID>"},
  "subjectsSha256": "<SHA-256 of RFC 8785 JSON for the ordered subjects array>",
  "responseSha256": "<exact request digest>",
  "checkedAtMs": 0,
  "expiresAtMs": 0
}
```

Both sides pin an RFC 8785 cross-language test vector for `subjectsSha256`; Core already has a strict JCS codec and Meri has `canonicalSha256`. Meri checks every receipt field, exact principal, freshness, and a recomputed `subjectsSha256`, then recomputes the hash of the frozen bytes immediately before synchronous publication. **Core cannot prove response byte membership from a hash alone:** it validates the resource vector and echoes the opaque response digest. Meri's projection equality and byte binding close that part of the contract. No receipt may be cached or replayed for a later page.

## One decision point, including Clerk

Core's current identity is a live Clerk session observation plus local user, tenant, membership, and optional impersonation facts. A PostgreSQL snapshot alone cannot atomically cover Clerk. The proposed Core owner performs an initial existing identity read, then one bounded tenant-scoped `REPEATABLE READ` transaction. In deterministic order it locks every local fact whose mutation can revoke this response: user, tenant, membership/impersonation, each conversation, client, applicable wall-grant row, and applicable prospect/portfolio rows and grants. It validates every requested subject through transaction-aware versions of the existing owner predicates. Raw lock SQL must include explicit tenant/actor predicates because Core's runtime role bypasses RLS for bare SQL. A changed row, missing lock target, unsupported scope, serialization failure, or timeout refuses the whole request.

**While all those local locks remain held**, Core performs a last online check of the same Clerk session through its existing request-bound identity owner and requires the original identity revision and principal. The completed online observation is the proposed source-level authorization decision point, conditional on the Clerk API's observed active-session semantics. The local locked facts are simultaneously valid at that point. Commit failure withholds the receipt. Core must not claim a cross-system atomic snapshot, a guarantee against Clerk's own stale observation, or retroactive denial for revocation after that decision point. A separate transaction for final local checks would break the claimed boundary; refactor the identity owner to accept the active transaction rather than nesting `withSystem` inside it.

Meri first reads and validates the candidate, completes whole-page retention filtering under its existing fence, checks response size, serializes/fixes bytes, and runs its existing membership recheck. The final awaited authorization operation is **one** Core history-release call for that exact vector and byte digest. It validates the receipt and publishes the frozen bytes synchronously, with no further async owner check in between. The history HTTP owner needs a narrow final-release hook after the product HTTP owner's membership recheck; calling Core from the present per-row service does not meet this order. Meri's separate retention fence must remain effective until publication. Core mutation after the decision point is a later event, not a retroactive failure of this read.

Explicit Core denial, expiry, malformed echo, unavailable route/transport, deadline, cancellation, unknown scope, or partial vector check yields no success body or partial page. Preserve existing safe `ACCESS_DENIED`/`CONVERSATION_UNAVAILABLE` mapping and `no-store`; do not turn a read failure into a next-turn write or a retry with a different bearer.

## Minimum source touch list and checks

Core: a strict DTO/receipt validator and thin route under `apps/api/src/auth/`; one owner service using `PrismaService.withTenant` with an isolation-level option; transaction-aware leaves for `loadOwnedActiveClioConversation`, `ContextSecurityScopeService.resolveApplicationAuthorityClient`, `BizDevMeriScopeService.assertCurrent`, and the already transaction-taking research-portfolio owner; a request-bound Clerk/local-identity recheck using the **same** transaction; authority-module registration and focused tests. Do not alter the existing `/context` contract, membership revision, current admission snapshot, or grants. Keep the added route native-only.

Meri: one bounded Core HTTP adapter beside `apps/runtime/native-authority/conversation-currentness.mjs`; exact response-to-subject projection and byte freezing in `apps/control/conversations/history/`; a narrow final-release seam in `apps/control/product-access/http.mjs` after its existing membership recheck; composition in `apps/runtime/product-applications.mjs` and the candidate's existing Core origin. Keep PR180 pool code and retention implementation under their existing owners.

Focused tests: empty/list/transcript exact echoes; same-count subject substitution, order change, missing/extra conversation, client/scope mismatch, duplicate/overflow, raw cursor omission, changed bytes, and expired receipt; archived conversation, client archive/wall grant deletion, prospect/RP scope drift, membership/impersonation change, online Clerk revocation, and Core outage; PostgreSQL barriers at each local lock and Clerk lookup to show one coherent decision or whole-response refusal; serialization conflict and pool exhaustion fail closed; no effect or next-turn admission on read failure. A revocation **after** the decision observation must not be mislabelled a predecision leak. Mocked tests are not live role, Clerk freshness, or deployment readback.

## Source anchors

- Core `application-membership.service.ts:25-77`, `application-membership.ts:37-45`: membership receipt and revision.
- Core `application-authority.ts:143-196`, `application-authority.controller.ts:45-53,82-99`: single-conversation context and separate owner calls.
- Core `tenant-context.middleware.ts:80-95,687-785`, `clerk.service.ts:127-169`: three-route marked-token restriction, live Clerk and local identity.
- Core `prisma.service.ts:145-169`: current tenant transaction lacks an isolation-level option; `context-security-scope.service.ts:27-51` and `bizdev-meri-scope.service.ts:188-217` open their own transactions.
- Meri `history/service.mjs:11-24`, `product-access/http.mjs:51-60`, `native-authority/conversation-currentness.mjs:10-40`: current per-row and final-membership order.
