# PROS-017 — prospect Contacts candidate

## Ownership and status

Base: `fd8765ec01d292013758606204f2c9d886cd31c1`, branch
`codex/portfolio-prospect-contacts-20261011`, checkout `C:\dev\cap-pros-contacts-261011`.
Policy: `b32b4803933760dc0a93fffdcd8fba30a89c3aac`, local machine map
`2026-09-30T00:21:48.2698715Z`. No shared source, schema, migration ledger, CORS,
authentication, deployment or data has been changed.

The candidate controller is **unregistered**. `UNALLOCATED-proposal.sql` is outside
the migration ledger and **unapplied**. Local PostgreSQL tests do not establish live
integration. Root owns review, coordination, migration allocation and registration.

## Proposed API

Prefix: `/api/business-development/prospects/:prospectId/contacts`.
Every route uses the existing `RolesGuard` (standard_user or higher), existing
`BusinessDevelopmentFlagGuard`, server-provided `TenantContext`, and
`PrismaService.withTenant`. No prospect ID is sent to a Client endpoint.

| Method | Route | Input | Response |
| --- | --- | --- | --- |
| GET | prefix | optional `after` UUID | `{prospectId,readOnly,contacts,nextCursor}` |
| POST | prefix | name, optional title/email/phone/notes, `requestId` UUID | Contact |
| PATCH | prefix/:contactId | full form snapshot, `expectedVersion` positive integer | Contact |
| DELETE | prefix/:contactId | `{expectedVersion}` | `{id,prospectId,removed:true,version}` |

Contact: `id`, `prospectId`, `requestId`, `name`, nullable `title/email/phone/notes`,
positive integer `version`, ISO timestamp `createdAt/updatedAt`. Server strips
tenant IDs, actor IDs, create hash and removal metadata from receipts.

GET pages contain at most 50 active contacts, keyset ordered by UUID; client fetches
all pages and orders by createdAt/id. UUID order avoids cursor invalidation when
the preceding contact is removed. No count is invented.

Name is trimmed and required (1–300); title 300, email 320 + email validation,
phone 120, notes 4000. Optional blank fields normalize to null. PATCH requires name
and replaces the five editable fields; omitted optional fields clear them. Unknown
input keys are rejected by the existing global ValidationPipe. Version strings are
not implicitly coerced.

POST replay: same tenant/prospect/requestId and same normalized original payload
returns the existing record, including after lifecycle changes. Changed payload or
a removed original returns409. The create hash is immutable across contact edits.
The prospect row lock serializes create requests, contact mutations, dismissal and
the existing conversion row lock. Database unique request key is a second safeguard.

Edit/remove: matching tenant/prospect/contact plus exact version required. Missing
or cross-tenant IDs return404. A stale version returns409 without a partial write.
Removal archives the row and increments version; the record and create identity are
retained. Repeated removal returns404. No emails are sent.

Dismissed, linked or converted prospects are readable but reject new writes409.
Source records remain firm-private, never copied into canonical/global identity.
Every raw SQL statement binds tenant and prospect explicitly because Prisma model
scope injection does not protect raw SQL. The composite FK and FORCE RLS provide
additional protection; tests also run service queries under an owner connection.

## Registration proposal (root-owned)

After schema allocation/application and owner review, import `ProspectContactsModule`
from `./prospect-contacts/prospect-contacts.module.js` and add it to the existing
BusinessDevelopmentModule imports. The new module exports `ProspectContactsService`
and reuses global Auth/Prisma foundations. Do not add contacts handlers to the giant
existing controller/service. No new frontend proxy root is needed.

## Conversion carry-over dependency

**Not implemented.** Current source contacts survive conversion and remain readable
through their original prospect. No client contact, email history, hierarchy or
association is created by this candidate.

The canonical destination is `ClientPerson` (`client_people`) managed by
`ClientPeopleService`. Its `createPerson` opens its own transaction and schedules KB
indexing; calling it inside conversion would break atomicity. The coherent extension
is an explicit transaction helper owned by ClientPeople, reusing its title placement
rules, plus a durable same-tenant source mapping from prospectContactId to
clientId/clientPersonId. The mapping must have a unique source-contact key so retries
cannot duplicate destination people. Preserve source version and original prospect.

Proposed hook: `carryContactsToClientInTransaction(ctx, tx, prospectId, clientId)`
after BusinessDevelopmentService.convert locks and validates the chosen Client and
before it stamps the prospect link/activity and commits. It must use that same `tx`,
exclude removed contacts, and schedule KB indexing only after commit. Existing linked
retries must consult/recover the durable mapping without duplicating client people.

Required decision/contract owner: root + ClientPeople/conversion owner. When linking
an existing client, decide explicitly whether an exact email match reuses an existing
person, and how multiple matches and conflicting titles/notes are reviewed. No fuzzy
name merge or overwrite is inferred. Historical conversions need an explicit backfill
decision; this candidate does not run one.

## Verification

11 tests PASS: production service SQL executes on ephemeral PGlite PostgreSQL,
including persistence/readback, create replay/hash, owner-connection tenant404,
CAS and soft removal, lifecycle conflicts, all51 pagination, application-role RLS,
role floor, SQL parameter binding, actual Nest DTO/role metadata/guard behavior.
Focused TypeScript (candidate source/tests + imported foundations) PASS using existing
borrowed declarations; no install or shared writable node_modules. Source Prettier PASS.

Initial setup outcomes remain visible in task evidence: full-program ts-jest exhausted
its default4GB heap before tests; focused transpile-only ts-jest retained all assertions.
PGlite required Node's `--experimental-vm-modules`. The focused typecheck then found and
fixed nullable INSERT/cursor handling and test fixture typing. SQL parser is not part
of installed Prettier; SQL is LF-checked by an assertion and executed by PostgreSQL.

NOT RUN: registered full AppModule/HTTP deployment, migration ledger/application,
native PostgreSQL multiconnection contention, shared backend deployment/live accounts,
conversion carry-over, provider operations. Root final acceptance owns these gates.
