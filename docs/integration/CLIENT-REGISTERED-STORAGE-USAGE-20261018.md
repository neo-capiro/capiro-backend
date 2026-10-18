# Client registered storage usage — Portfolio PR95

Source successor of Core PR86 `b40971b1f8de888687a8fb92fbdf4ff653fe10d3`.
Consumer: [frontend PR95](https://github.com/neo-capiro/capiro-frontend/pull/95),
`evidence/figma/decision-and-wiring.md`, Files nodes `1064:167100` and `1064:167588`.
This source has not been deployed or exercised against a live authenticated API.

## Route and response

`GET /api/clients/:clientId/files/storage-usage`, mounted by the existing
`ClientFilesController` in `ClientsModule`. Successful responses are HTTP 200 with
`Cache-Control: no-store`. The tenant comes from native authenticated request context,
never a query parameter. The controller requires `standard_user` or above.

Example only, not observed production usage:

```json
{
  "clientId": "22222222-2222-4222-8222-222222222222",
  "source": "engagement_attachments",
  "usageBasis": "registered_attachments",
  "allowanceScope": "client",
  "asOf": "2026-10-18T00:00:00.000Z",
  "allowanceBytes": 10737418240,
  "enforcement": "report_only",
  "status": "available",
  "usedBytes": 12000,
  "remainingBytes": 10737406240,
  "overAllowance": false
}
```

The allowance is **per client**, not a tenant or account pool. It is read from
`CLIENT_STORAGE_QUOTA_BYTES` in `packages/shared/src/index.ts`: 10 × 1024³ bytes
(10 GiB; Figma labels this 10 GB). The existing policy is reported, not enforced.
`overAllowance` is true only when usage is strictly greater than the allowance;
remaining bytes clamp to zero. This endpoint does not deny uploads.

If any in-scope row has null/negative size metadata, the response instead has
`status: "unavailable"`, `reason: "incomplete_size_metadata"`, and null `usedBytes`,
`remainingBytes`, and `overAllowance`. An unsafe JSON integer total produces the
same unavailable shape with `reason: "unsafe_total"`. The allowance and source
labels remain present. An empty registry returns available zero; a stored zero
byte size is valid. Database errors propagate as errors, never as zero usage.

Frontend wiring should fetch this snapshot separately from the ACL-filtered
`engagement/attachments?clientId=...` list. Use the meter only for `available`,
label it as registered file storage, and show usage unavailable for incomplete
metadata or a failed request. Refresh after upload confirmation or deletion;
`asOf` is the database statement timestamp of the aggregate, not the file list's
timestamp or an object-store inventory timestamp. File names, ids, owners, ACLs,
object keys and private file counts are not returned. Loading and error handling
must not reuse a prior client's snapshot. Figma's unavailable state and the
frontend query/rendering change remain with the frontend owner.

## Accounting source and boundaries

The query reads the canonical `engagement_attachments` registry using explicit
tenant and client predicates plus `prospect_id IS NULL`. It uses one PostgreSQL
aggregate statement with bigint arithmetic and no pagination or file visibility
predicate. Current, superseded, restricted, quarantined, blocked, delete-pending
and delete-failed rows all count. Supersession retains the old object and row;
completed deletion removes the row. A retained row can conservatively remain
counted while object deletion has completed and registry cleanup is pending.

Canonical source evidence:

- `apps/api/prisma/schema.prisma`, `EngagementAttachment`: nullable integer
  `byteSize`, stored `clientId`, lifecycle and supersession fields.
- `apps/api/prisma/migrations/20260503020000_engagement_manager_core/migration.sql`:
  unique `(tenant_id, s3_key)` and tenant RLS policy. One registered key cannot
  appear twice in a tenant when this schema invariant is installed. Do not
  deduplicate by name, content hash or byte size; distinct objects still consume
  separate registered storage. Deployment must retain this existing constraint.
- `apps/api/src/engagement/engagement.service.ts`: confirmation reads S3's
  `ContentLength`; buffer-created attachments record their actual byte length;
  `attachmentClientAtWrite` inherits the current meeting client under lock;
  meeting reassignment updates attachment client attribution atomically.
- That same service's `listAttachments` applies viewer and supersession filters,
  so it cannot supply this total. Mail-only or unlinked files with null client
  attribution are not inferred into a client by joins, names or mailbox context.
- The prospect-resource-origin migration prohibits simultaneous prospect and
  client/meeting/mail parentage. Prospect storage is a separate scope.

This is authoritative **registered attachment usage**, not physical S3 billing.
Unconfirmed/orphaned objects, object versions and nonattachment assets are outside
the registry. `infra/cdk/lib/assets-stack.ts` enables bucket versioning and retains
noncurrent versions; ordinary attachment deletion does not provide `VersionId`.
Physical storage measurement would require a separate inventory/reconciliation
contract. The existing confirmation writer maps a zero `ContentLength` to null;
those legacy records correctly yield unavailable until their canonical metadata
is repaired by its owner. This change does not fabricate or backfill sizes.

## Authorization and runtime integration

The new aggregate read reuses `requireOwnerClient`, the current client team/owner
read boundary: fresh active membership tied to the Clerk actor, current role of
at least `standard_user`, same-tenant nonarchived client, and the canonical client
ethical-wall predicate with no administrator bypass. Invalid, foreign, archived
or walled client ids return 404; missing, stale or insufficient membership returns
403. It holds the helper's client/membership/grant locks within the existing
tenant transaction through aggregation. Raw SQL includes explicit tenant scope
because the application's runtime database role can bypass RLS.

This is deliberately stricter than the old attachment-list parent existence
check. Older Files reads and downloads retain their existing behavior; no file
ACL is changed. An aggregate does not grant access to any attachment bytes.

The ordinary Core module mounts the route in source. The restricted first-chat
preview listener does not allow this GET path. A separately owned routing and
deployment step must expose it where Portfolio runs, after source qualification;
this PR does not edit the shared listener packet. No new schema migration is
required. Production schema/unique-constraint verification, actual Prisma/RLS
behavior, current-session authentication and frontend-to-Core routing remain
runtime qualification work. No AWS, live SQL, security grant, credential, image
build, or paid service call was performed.

## Focused verification

`client-storage-usage.spec.ts` runs actual SQL against an in-memory PGlite
PostgreSQL fixture plus a minimal Nest HTTP application. The adapter supplies
Prisma's transaction surface and synthetic authenticated context; it does not
claim native Prisma/RLS, concurrency, or live bearer qualification. Coverage:
empty and zero sizes; hidden and superseded files; every retained lifecycle;
other clients/tenants and unlinked exclusions; pending deletion cleanup; unknown
and invalid metadata; exact totals above 32 bits and at/over 10 GiB; unsafe JSON
totals; current membership and Clerk identity; archived/foreign/walled clients;
no admin wall bypass; response fields, `no-store`, and controller role denials.

The focused run uses Node 22 with `--experimental-vm-modules`, Jest `--runInBand`,
and an isolated TypeScript transform (1 GiB heap cap). The first attempt omitted
the VM-modules flag and could not initialize PGlite; the corrected run passed
16/16. A strict TypeScript invocation restricted to the two changed TypeScript
entrypoints exhausted its 1 GiB heap while loading transitive types; it did not
complete and is not a passing typecheck. No larger retry was run on this shared,
resource-constrained host. Independent source review found no blocking issue.
Final `git diff --check` passed.
