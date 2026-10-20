# Core current-membership source contract

This independent increment starts at `016e79b585c14f20d13669e13c987c01e3dd29dd`. It adds a native Core sibling endpoint; it changes no existing identity/context receipt, schema, credentials, Meri source or retained-read delegation.

## Request and response

`POST /api/clio/application-authority/membership`, `Authorization: Bearer <native Capiro/Clerk user bearer>`, JSON body exactly `{}`. Existing tenant middleware verifies the principal and owns request-local provenance; caller/model tenant, actor, role, client and service-secret hints cannot substitute for it. Existing tenant selection remains subject to that middleware's verified claims and current database checks.

Optional `x-meri-deadline-at` is an unsigned decimal safe-integer absolute epoch millisecond timestamp. It may only shorten the endpoint's 30-second lifetime. Deadline/abort rejects a pending response and closes the control; late I/O cannot continue to a successful receipt. This does not promise cancellation or rollback of underlying already-started I/O. The canonical Clerk owner independently bounds each online session read to two seconds. No token, reusable authorization callback or credential is returned.

Successful status `200`, `Cache-Control: no-store`, JSON with exactly:

```ts
{
  tenantId: string;             // lowercase UUID, verified selected tenant
  actorId: string;              // lowercase UUID, canonical database user
  status: 'active';             // inactive membership is refused
  role: 'standard_user' | 'user_admin' | 'capiro_admin';
  permissions: [];              // adds no Core business/product grants
  clientIds: string[];          // sorted unique lowercase UUIDs; at most 4096
  membershipRevision: string;   // lowercase SHA-256, observation digest
  checkedAtMs: number;          // safe integer, generated after current reads
  expiresAtMs: number;          // minimum original identity/session bounds
}
```

An empty actual permitted client roster is `[]`; it does not mean all clients. The response never emits suspended/removed status or a client-portal role. It requires an actual active selected-tenant membership at the existing standard-user floor. A cross-tenant administrator impersonation with no such membership is refused; no target membership or wall bypass is invented.

The client list comes from the existing `fetchAccessibleClientRevisionsForClerkActor` SQL owner: selected-tenant active membership, nonarchived client and open wall or actual user grant. Its actor argument is the verified **Clerk user ID**, not the database actor UUID. The sole helper extension is an optional bound, using 4097 as an overflow sentinel. Overflow is unavailable, never a truncated roster. Existing callers retain unbounded roster semantics with a bound SQL `LIMIT NULL`.

## Current facts and revision

The service reads online identity, membership/client snapshot, fresh online identity, another snapshot, the existing local identity recheck, then a final snapshot. Each snapshot brackets the canonical wall query with actual selected membership/tenant reads. Each await is followed by a request-control check. Observed identity or membership/client changes reject. Local denial by the canonical owner may precede a comparison and remain 401/403.

`membershipRevision = SHA256("capiro-application-membership-v1\n" + JSON.stringify([tenantId, actorId, membershipId, "active", actualRole, membershipUpdatedAtMs, "active", tenantClerkOrgId, sortedClients.map(({id,revision}) => [id,revision])]))`. The namespace contains one actual newline. Membership and client source revisions are included; token/receipt clocks and session IDs are excluded. It is an observation digest, not an authorization grant, snapshot lock or historical-change log. A revoke/regrant or other transient change invisible at every observation is not attested. Existing client row revisions do not include grant-row history. Fresh current checks remain necessary before later actions or release.

Receipt expiry cannot extend the original verified bearer, online session, abandon or impersonation cutoff. The caller's operation deadline bounds this response, without manufacturing a membership lease or changing the original expiry. Startup owns request-lifetime credential propagation and membership recheck comparisons on its side.

## Error behavior

| Status | Meaning |
| --- | --- |
| 400 | Body has any fields, wrong shape, or deadline header is malformed. |
| 401/403 | Existing native authentication/session/guard/provenance denial; missing, inactive, foreign, below-floor or invalid current membership. |
| 408 | Caller deadline, maximum request lifetime, or request disconnect/abort. |
| 409 | Changed observed identity or membership/client revision; reload current authority. |
| 503 | Current roster/database source unavailable, malformed, duplicate, or above the bounded roster limit. |

Error bodies use existing Nest error envelopes; no new globally shared error projection is introduced. The no-store route list also covers authentication denials before the controller.

## Ownership and limits

New source is `auth/application-membership{,-request,.service,.controller}.ts`. Existing changes are narrow registration in `auth/application-authority.module.ts`, the optional roster-query bound, two no-store path entries, and focused specifications. `TenantContextMiddleware.readApplicationAuthority`, Clerk verification, role definitions and wall predicates remain authoritative. Existing identity/context source bytes and receipt shapes are unchanged.

Startup owns `createMembershipGate` and the request-local native bearer closure. The Core endpoint needs the existing Core Clerk verification configuration and native request bearer; this change creates/configures neither. Missing transport or usable native authority must remain unavailable. A Meri capability or an internal service secret alone cannot stand in for a native user bearer.

Membership supplies no conversation/folder/portfolio-to-current-run corroboration and no task-bound retained-resource delegation. READS still needs those separately allocated owners. There are no provider calls, shared-database operations, live session probes, credentials changes or availability claims in this source handoff.

Focused tests use actual source, request provenance and registered Nest handlers with synthetic Clerk/database I/O, no listening socket. Broad typing/build/browser/native and integrated source qualification are deferred to the reviewed integration checkpoint. Their absence is not a passing release result.
