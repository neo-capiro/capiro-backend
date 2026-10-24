# Internal support requests

The authenticated Help form stores one immutable report for Capiro HQ review.
The receipt means **saved for HQ review**. It does not mean emailed, resolved,
or assigned an SLA. No attachment, automatic run-content lookup, outbound
delivery, status workflow, queue or sync outbox is introduced.

`POST /me/support-requests` takes a client-generated UUID, summary (1–200),
detail (1–5000), and an optional opaque run reference (1–200). Text is trimmed.
Tenant and submitter come only from the canonical authenticated context.
Current active tenant and membership are checked under row locks in the
transaction. Concurrent same-ID, same-normalized-payload requests return the
original record and timestamp; a different payload or ownership conflicts.

`GET /me/support-requests/:id` returns only the current caller's own report
within their current tenant. The frontend binds the entire receipt to the
captured payload, actor and tenant. A lost response retains only request ID,
scope and a payload hash in the existing nonreplayable Settings journal.
Recovery is an exact GET, never a duplicate submission or a matching-title guess.

HQ uses `GET /capiro-admin/support-requests?tenantId=…&cursor=…` and
`GET /capiro-admin/support-requests/:id?tenantId=…`. The existing staff guard
and a fresh active staff-membership check apply. Lists contain at most 50 rows,
ordered by creation time and ID; continuation belongs to the selected tenant.
Detail is plain text. Cross-tenant staff reads write metadata-only audit rows;
report content and run references are not copied to logs or audit metadata.

The source-only migration `20281024030000_support_requests` enforces text
bounds, tenant RLS, immutable UPDATE behavior, and tenant/user deletion cascades.
It follows the existing tenant hard-delete owner. No support-specific timed
retention policy was found or invented; that policy remains an explicit product
question. Removing a membership revokes its own-receipt access without deleting
the report. User or tenant destruction removes the record.

Focused unit, contract, receipt-recovery and presentation tests run without a
database or providers. Root must still qualify real PostgreSQL concurrency,
rollback, revocation, RLS and deletion cascades; browser/keyboard behavior; and
the final composed native runtime. Dependency closure regeneration is unchanged.
Raw image schema pins are updated; generated companion hashes require the
existing native Prisma diagnostic, as documented by
`docs/runtime-production-closure-20261014/PRISMA-NATIVE-EVIDENCE-20261024.md`.
Host formatter hashes are not native acceptance. No migration has been applied.
