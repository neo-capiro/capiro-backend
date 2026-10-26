# Exact rich-newsletter create/save recovery

Workspace's NewsletterService remains the sole mutation/access owner. Core checks current membership,
document owner/editor access and every source client. This contract introduces no delivery action.

## Routes and response

- `POST /workspace-api/newsletters/documents`: required UUID `requestId`, optional `name`, `templateId`.
- `PATCH /workspace-api/newsletters/documents/:id`: required UUID `requestId` plus the existing
  `revision`, `name`, `design`, `config` save inputs.
- `GET /workspace-api/newsletters/write-requests/:requestId`: read-only, current-access lookup of the
  same authenticated tenant/actor's exact request. It never activates invitations or writes.
- Existing `GET /workspace-api/newsletters/documents/:id` supplies **current content**, separately.
  Existing preview and stage response/read contracts are unchanged.

Both mutations and a successful lookup return the same content-free `NewsletterWriteReceipt`:

```ts
{
  requestId: string; operation: 'create' | 'save'; documentId: string;
  previousRevision: number | null; revision: number;
  inputHash: string; contentHash: string;
  hashFormat: 'newsletter-write-jcs-v1'; createdAt: string;
}
```

Create commits revision 1 with `previousRevision: null`. Save commits exactly `previousRevision + 1`.
`createdAt` is the database receipt timestamp, not a new document-version or physical commit clock.
Neither response contains a current document snapshot. A later GET at revision 4 cannot replace a
receipt proving this request committed revision 2.

`inputHash` is SHA-256 of the existing strict RFC8785 server canonical JSON encoding:
- Create: `{operation:'create', name: suppliedName ?? null, templateId: suppliedTemplateId ?? null}`.
- Save: `{operation:'save', documentId: lowercaseUUID, revision, name, design, config}` before
  existing validation/sanitation. Object-key order is immaterial; changed submitted values are not.
- `contentHash` uses the same encoding of `{name, design, config}` actually persisted after validation,
  sanitation, default/template/brand application and source-client union. It is not a content cache.

The existing public newsletter namespace exports the request/receipt types and
`parseNewsletterWriteReceipt(value, expected)`. Expected request ID and operation are mandatory;
save also requires original document ID and base revision. Known input/content hashes can be pinned.
Malformed/unbound/partial/extra fields refuse. `parseNewsletterCampaign` remains current-content
parsing, not proof of a write. Integration owns compilation, immutable distribution and consumer pins.

## Atomicity, access and deletion

`ws_newsletter_write_receipt` is keyed by `(tenant_id, actor_id, request_id)` across create/save.
The existing draft convention serializes a request with a transaction-scoped PostgreSQL advisory lock.
The mutation and insert of its receipt share one transaction. Different save requests still contend
on the existing document revision CAS. Receipt failure rolls back the mutation. No catch converts an
uncertain commit acknowledgement into a failed or replacement mutation.

Exact replay returns the original receipt without another create/save, even after later revisions.
Reusing the ID with changed inputs, operation or document returns 409. There is no optional unbound
mutation path: missing/malformed IDs return 400. Normal stale-revision conflicts remain 409.

Readback and replay recheck current membership, owner/editor access and source-client access. Only the
requesting actor can retrieve its receipt. Another actor/tenant sees no matching receipt (`null`), not
another actor's write. Current access denial is 404. Recorded source-client IDs remain internal and are
also checked, even if a later document state differs. Recovery never activates a pending invitation.

The receipt has **no document FK/cascade**. Document deletion leaves its request fence: replay and
readback refuse current document access (404), rather than recreating the deleted document. Tenant
RLS is enabled and forced with `app.current_tenant`, following the existing owner-local receipt
convention. `capiro_app` receives SELECT/INSERT only; UPDATE/DELETE/TRUNCATE are revoked and UPDATE/DELETE
also have an immutable trigger. No content, foreign authority, legacy identity or backfill is added.

## Paired frontend and Release acceptance

The current rich frontend calls create/save through
`apps/web/src/shared/capiro/operations/rich-newsletter.ts` and its feature document-controller/adapter.
Those existing unbound requests/current-campaign mutation receivers require paired adoption. The
frontend must retain a UUID and exact inputs in the existing recovery journal **before** dispatch,
bound to the current tenant/actor and document/client lifetime. Reopen/reload/unknown outcomes GET the
retained request. A null/denied/unavailable read is not proof no commit occurred and does not authorize
automatic redispatch or a new request ID. An exact committed receipt may be followed by an explicitly
separate current-document read/adoption; later content must not overwrite retained unsaved edits or
be presented as the original write result. No send or invitation activation follows reconciliation.

Release owns activation in the 26 October 2026 Wave3 paired preview rollout, after independent
source/fixture review, native qualification, Integration's public package and the paired consumer.
The migration is `20261026070000_newsletter_write_receipt/migration.sql`; apply it once, forward only.
Author checks do not constitute native, production-image or deployed authenticated acceptance.

Native fixture: `apps/workspace/test/newsletter-write-postgres.int-spec.ts`, eleven finite cases.
Release alone supplies an explicit helper-validated loopback `a1_disposable_*` PostgreSQL16 URL and
opt-in. Existing ordinary `capiro_app` must have no role memberships and all six elevated attributes
false. Prepare citext/vector/pg_trgm/uuid-ossp in pg_catalog of that wholly new disposable database.
The fixture uses exact accepted Core+Workspace base `21f5fd3ebd2dce585e5c7e1b6267bf5b8f97b70c`, seeds a
synthetic old newsletter, then applies this exact SQL once in the same owned schema. Raw pg explicitly
sets and verifies schema/database; clients, temp files and owned schema clean up on failure. This
qualifies changed receipt DDL/RLS/grants/transactions, not all historical Core migration behavior.

Expected cases: base preservation; overlapping create; committed create ACK loss; input/operation
mismatch; actual overlapping save CAS; committed save ACK loss plus later revision; actual receipt
constraint rollback for both mutations; deletion without resurrection; actor binding and tenant RLS;
membership/editor/source revocation; immutable privileges, unique key and revision constraints.
No PostgreSQL connection is attempted when the allocation variable is absent. Skipped collection
means NOT RUN. No model/provider/email/cloud operation is part of the fixture.
