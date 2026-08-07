# Engagement Phase 3 Parity Fixture Catalog

**Phase:** 3 — Full Existing Engagement Experience Parity
**Micro-session:** 3.2 — Build deterministic full-parity fixtures
**Plan:** `apps/api/scripts/engagement-phase3-fixture-plan.ts` (pure, no database)
**Seed:** `apps/api/scripts/seed-engagement-phase3-parity-fixtures.ts`
**Contract:** `apps/api/src/engagement/__fixtures__/engagement-phase3-fixture-contract.v1.json` (generated)
**Suite:** `apps/api/scripts/seed-engagement-phase3-parity-fixtures.spec.ts` (43 assertions)

This document explains what the fixture set covers, what it deliberately does
*not*, and why each choice was made. Sessions 3.5–3.11 consume it; 3.14 reviews
it.

---

## 1. Shape

**116 rows across 26 tables in 3 tenants, plus 3 ids that must resolve to
nothing.** 55 declared states, covering all 52 fixtures the plan enumerates.

| Group | Rows | Group | Rows |
|---|---:|---|---:|
| tenants | 3 | outreach records | 15 |
| users | 7 | draft artifacts / versions | 3 / 4 |
| memberships | 7 | send intents / deliveries | 1 / 1 |
| impersonation sessions | 2 | audiences / members | 2 / 4 |
| clients | 4 | templates / AI templates | 1 / 1 |
| client memory grants | 2 | report target offices | 5 |
| contacts | 6 | integration connections | 4 |
| meetings | 12 | attendees | 10 |
| notetaker sessions | 5 | preps | 4 |
| notes / debriefs | 3 / 2 | tasks | 5 |
| attachments | 3 | absent ids | 3 |

---

## 2. Commands

```bash
export DATABASE_URL='postgresql://capiro:capiro@127.0.0.1:55474/capiro?schema=public'
export NOTES_ENCRYPTION_KEY='<base64 32 bytes>'
export NOTES_ENCRYPTION_KEY_VERSION='phase3-local'

pnpm -C apps/api exec tsx scripts/seed-engagement-phase3-parity-fixtures.ts --apply --verify
pnpm -C apps/api exec tsx scripts/seed-engagement-phase3-parity-fixtures.ts --cleanup
pnpm -C apps/api exec tsx scripts/seed-engagement-phase3-parity-fixtures.ts --check-contract
pnpm -C apps/api exec tsx scripts/seed-engagement-phase3-parity-fixtures.ts --write-contract

pnpm -C apps/api exec jest --runInBand --forceExit scripts/seed-engagement-phase3-parity-fixtures.spec.ts
pnpm -C apps/api exec tsc -p tsconfig.engagement-phase3-fixtures.json --noEmit
```

`ENGAGEMENT_PHASE3_FIXTURE_FILE` writes a key → id index for a browser harness.
`ENGAGEMENT_PHASE3_ANCHOR` pins the run anchor.

---

## 3. Three design decisions

### 3.1 The contract stores temporal *descriptors*, not timestamps

No fixture row carries an absolute time. Each temporal field is one of:

```text
anchorOffset  { minutes }                              relative to the run anchor
anchorDay     { dayOffset, hourUtc, minuteUtc }        whole days from the anchor, pinned UTC clock time
cycleDate     { cycleYearOffset, monthIndex, day, … }  a fixed date inside the current or previous report cycle
```

Two failures this avoids:

- **Contract churn.** A literal `2026-08-06T…Z` would make the committed contract
  regenerate differently every day, so `--check-contract` could never mean
  anything.
- **A silent cycle bug.** `reportPeriodWindow` resolves report periods as calendar
  years *at request time*. An anchor-relative "−7 days" fixture falls into the
  previous cycle every January, so the "current period" fixture would test the
  previous period for the first week of each year. `cycleDate` is why
  `meeting.reportCurrentCycle` is in the current cycle in any year.

`anchorDay` exists because of a defect this session's own test caught: the
timezone-boundary meeting was first written as `anchorOffset(7 days + 7h30m)`,
which inherits the anchor's time of day. At an anchor of midnight UTC it resolved
to 07:30Z, which is *the same local date* in `America/Los_Angeles` — so the
fixture whose entire purpose is to make UTC and local day-bucketing disagree did
not. It is now pinned to 03:30Z, which is the previous local day at both DST
offsets, and the test asserts divergence from four anchors spanning both halves
of the year.

Verified in the database:

```text
starts_at 2026-08-14 03:30:00+00 · local_date 2026-08-13 · utc_date 2026-08-14
```

### 3.2 Typed Prisma, not raw SQL

Phase 0's seed used `$executeRawUnsafe` with inlined UUIDs. At 116 rows across 26
tables, a schema mistake caught by `tsc` costs seconds; the same mistake caught by
Postgres costs a container round-trip per attempt. `tsconfig.engagement-phase3-fixtures.json`
exists because the base tsconfig excludes `scripts/` — without it the typed client
would buy nothing. It is wired into `pnpm --filter @capiro/api typecheck`.

The seed applied cleanly against a real PostgreSQL 16 + pgvector container on the
first attempt, which is the return on that choice.

### 3.3 Cleanup deletes by tenant, not by row id

`OutreachDraftVersion.createdBy` is `onDelete: Restrict` against `users`. Once a
parity test authors a draft version against a fixture user, deleting that user by
id fails and cleanup leaves a half-removed fixture behind. The fixture owns its
three tenants outright, so cleanup deletes every row in them — which collects
test-created rows too. `users` is a global table, so it is deleted explicitly,
after every row that references it.

Cleanup order is declared in the plan and cross-checked against the seed's own
deleter map in both directions: a table seeded without a cleanup entry throws, and
a cleanup entry for an unseeded table throws. The suite asserts the same thing
statically, so the invariant holds even if the seed never runs.

---

## 4. Coverage

Every state below is machine-declared in the contract's `states` array with the
fixture keys that produce it. The suite fails if a required state is missing, if a
state cites a row nobody defines, or if a state names neither covering rows nor a
declared absence.

### Users and tenants

| Plan requirement | Covered by |
|---|---|
| admin | `actor.admin` (`user_admin` in the primary tenant) |
| standard user | `actor.standard` |
| below-required role | `actor.belowRole` (`client_portal_user`) |
| different user in same tenant | `actor.peer` |
| second tenant | `tenant.secondary`, `actor.crossTenant`, `client.secondTenant` |
| ethical-wall denied actor | `client.walled` (`memoryWall`), grants for admin+standard, **none** for `actor.wallDenied` |
| Capiro Admin impersonation | `tenant.capiroInternal`, `actor.capiroAdmin`, one active and one expired `ImpersonationSession` |

Both "when supported" fixtures **are** supported and are therefore real, not
skipped:

- Ethical wall: `Client.memoryWall` + `client_memory_access`, enforced by
  `apps/api/src/memory/memory-wall.helpers.ts`. A walled client with zero grants
  is invisible to everyone including admins, so the grants must exist for the
  *allowed* half of the comparison to be observable at all.
- Impersonation: `ImpersonationSession` rows started by a `capiro_admin`. The
  expired row is what 3.10 needs to prove expiry clears consistently.

### Meetings

| Plan requirement | Covered by |
|---|---|
| upcoming client / no-client | `meeting.upcomingWithClient`, `meeting.upcomingNoClient` |
| past | `meeting.past` |
| all-day | `meeting.allDay` (midnight→midnight UTC) |
| timezone boundary | `meeting.timezoneBoundary` (see §3.1) |
| multiple attendees | `meeting.multiAttendee` (4 attendees, one with no address) |
| deep-linked outside visible range | `meeting.deepLinkOutsideRange` (+400 days) |
| inaccessible | `meeting.otherTenant` — a real row in the second tenant |
| deleted | `absent.meeting` — a well-formed id with **no row** |
| prep | 4 preps: `generated`, `edited`, `approved` ×2 |
| notes | 3 notes: approved, draft, another user's confidential |
| debrief | 2 debriefs: `approved`, `generated` |
| tasks | 5 tasks: `todo` ×2, `in_progress`, `blocked`, `done` |
| attachment metadata | `legacy_ready`, `blocked` (scan `threat`) |
| notetaker statuses | `done`, `failed`, `no_show`, `requested`, `in_call` |
| accessible confidential content | `note.adminApproved` on `meeting.confidentialAccessible` |
| denied confidential content | `note.peerConfidential` (authored by `actor.peer`) |

### Outreach v2

All four current types (`campaign`, `follow_up`, `prep`, `outbound_campaign`) and
all four current statuses (`draft`, `sent`, `opened_in_email`, `failed`) appear,
asserted by the suite rather than by inspection.

| Plan requirement | Covered by |
|---|---|
| empty list | `tenant.secondary` holds zero outreach records |
| draft | `outreach.draft` (`lastStep` 1) |
| partially completed wizard | `outreach.partialWizard` (`lastStep` 4, one recipient, no body) |
| follow-up | `outreach.followUp` (linked to `meeting.past`) |
| prep distribution | `outreach.prepDistribution` |
| outbound campaign | `outreach.outboundCampaign` (with Cc and Bcc) |
| sent | `outreach.sent` (+2 immutable versions, both approved) |
| failed | `outreach.failed` (+ a `held` version) |
| opened-in-email | `outreach.openedInEmail` |
| delivery unknown | `outreach.deliveryUnknown` + intent + delivery — see §5.2 |
| client-directed | `outreach.clientDirected` (`direction: to-clients`) |
| external / on-behalf | `outreach.externalOnBehalf` (`direction: on-behalf`) |
| group recipient | `outreach.groupRecipient` (2 `groupMembers`, `group:` generation key) |
| missing email | `outreach.missingEmail` + `contact.noEmail` |
| attachment metadata | `outreach.withAttachment` → `attachment.outreach` |
| truthful nullable client | `outreach.nullableClient` (`clientId` stays null) |

Recipient sources for the wizard: 2 audiences (`list` + `group`) with 4 members,
1 saved template, 1 AI template.

### Reports

| Plan requirement | Covered by |
|---|---|
| current period | `meeting.reportCurrentCycle` + `reportTarget.autoAlpha` |
| previous period | `meeting.reportPreviousCycle` |
| empty period | `client.beta` has no meetings in any cycle |
| every status | `auto`, `not_started`, `in_progress`, `complete` across 5 targets |
| manual override | `reportTarget.manualOverrideAlpha` |
| meetings and pending actions | conditional — see §5.1 |

`scopeKey` follows `reportScopeKey(clientId) = clientId ?? 'all'`, so
client-scoped targets carry the client UUID and the firm-wide target carries
`'all'`. Verified in the database.

### Integrations

| Plan requirement | Covered by |
|---|---|
| Microsoft connected | `connection.microsoftConnected` |
| Google connected | `connection.googleConnected` |
| disconnected | `connection.disconnected` (`disabled`) |
| expired / error | `connection.expiredError` (`error` + `lastError`) |
| no connections | `tenant.secondary` holds zero connections |
| subscription metadata without provider calls | `connection.microsoftConnected.syncState.subscription` |

**Zero `IntegrationConnectionToken` rows exist.** That is the checkable invariant
behind "no real provider credential" — `--verify` asserts the count is 0 rather
than the catalog claiming it.

---

## 5. Limitations, and what each obliges a later session to do

### 5.1 `pendingActions` and report meeting rows need the S3 directory snapshot

`reportOverview` attaches meetings and pending actions **only inside its
directory-match loop** (`engagement.service.ts` ~5513), and directory data comes
from an S3 snapshot (`DirectoryService.getDirectoryData`), not the database. When
that read fails, `directoryMatchesForReport` swallows the error and returns `[]`,
so a database-only fixture produces report rows with `pendingActions: 0` and no
meetings, no matter what it seeds.

The fixture seats the one snapshot-independent directory address —
`avery.testwell@example.invalid`, the `TEST_DIRECTORY_CONTACT` compiled into
`directory.service.ts` — as an attendee on both report-cycle meetings, and hangs
two open tasks off the current-cycle one. With directory access the state is
reachable; without it, it is unreachable by *any* database fixture.

**3.8 must record this as a coverage limitation, not a parity failure.** The
behaviour is identical in main and preview (both read the same snapshot through
the same service), so parity is unaffected — but a run without directory access
has not *exercised* the state, and must say so rather than reporting green.

### 5.2 One pre-existing send intent and one delivery

`outreach.deliveryUnknown` requires a real `OutreachSendIntent` and
`OutreachDelivery`, because that is how the product represents an unknown outcome.

**3.7's external-denial invariants must therefore be deltas, not absolutes.** The
plan words them as "no job / no send intent / no provider row"; taken literally
against this fixture set they fail before any test runs. The correct assertion is
*no send intent or delivery beyond the declared fixture rows*, and the contract
declares exactly which those are (`sendIntents: 1`, `deliveries: 1`, both named).

The delivery carries `providerMessageId: null`. An unknown outcome has no
confirmed provider id, and recording one would assert a send nobody can prove
happened.

### 5.3 Attachments are metadata only

No S3 object backs any fixture `s3Key`, and the bucket is named
`phase3-parity-fixture-bucket-no-object` so this cannot be misread. 3.6's
download and extract-text scenarios must assert that the **runtime action is
refused**, not that a byte stream is missing — a missing object would produce the
same surface symptom for the wrong reason.

### 5.4 "Notes encryption unavailable" is a runtime-config state

3.6 lists it as an edge state. It is produced by starting the API **without**
`NOTES_ENCRYPTION_KEY`, not by fixture data — the seed *requires* the key,
because `MeetingNote.bodyCiphertext`/`iv`/`authTag` are non-nullable and a
plaintext body cannot be inserted. Bodies are encrypted by the product's own
`MeetingNotesCryptoService`, and `--verify` decrypts every one back to its
declared plaintext, so a cipher or encoding drift fails the seed instead of
producing rows the reading code cannot open.

### 5.5 Two reserved identifiers

Each costs a citation, so the cheap path stays "keep the fixture inside the marker
space".

| Value | Field | Why it cannot carry the marker |
|---|---|---|
| `capiro-internal` | `Tenant.slug` | `capiro_admin` is granted only when the org slug matches this reserved value (`bootstrap-capiro-admin.ts`). A marker-prefixed slug yields a tenant whose admin is not a Capiro admin, so the impersonation fixture would test nothing. |
| `avery.testwell@example.invalid` | `MeetingAttendee.email` | The only directory-resolvable contact without the S3 snapshot. See §5.1. |

Everything else carries `Phase 3 Parity` in a human-readable label and a UUID in
the `e3000000-0000-4000-8000-…` fixture space, both enforced by the suite.

---

## 6. Validation evidence

Run on 2026-08-06 against a dedicated disposable container (`engagement-phase3-fixtures`,
port `55474`, `pgvector/pgvector:pg16`, PostgreSQL 16.14) — a distinct name and
port from the containers other sessions have running.

```text
prisma migrate deploy                      All migrations have been successfully applied.
--write-contract                           OK  contract written
--check-contract                           OK  committed fixture contract matches a fresh build
--apply --verify   (first run)             OK  cleanup removed 0 rows across 27 tables
                                           OK  seeded 116 rows
                                           OK  every fixture row read back with the expected count and readable body
--apply --verify   (second run, idempotency) OK  cleanup removed 116 rows across 27 tables
                                           OK  seeded 116 rows
                                           OK  every fixture row read back …
--cleanup                                  OK  cleanup removed 116 rows across 27 tables
post-cleanup SQL count on e3000000% ids    tenants/users/meetings/outreach/connections/notes/deliveries all 0
tsc -p tsconfig.engagement-phase3-fixtures.json  clean
jest scripts/seed-engagement-phase3-parity-fixtures.spec.ts  43 passed
```

No AWS call, no migration, no provider adapter, no S3 object, no shared database.

---

## 7. Negative controls

Three the plan names, plus seven more the same machinery made cheap. Each corrupts
a real plan and asserts the specific rule fires — a suite that only checked the
healthy plan would still pass with every rule deleted.

| Control | Rule that must fire |
|---|---|
| Duplicate key (row cloned) | `unique-fixture-id` |
| Duplicate key (SQL insert of an existing tenant slug) | Postgres `tenants_slug_key` — verified live |
| Missing required status (`outreach.failed` state removed) | `required-state-covered` |
| Non-allowlisted external email (`real.staffer@mail.house.gov`) | `reserved-email-domains-only` |
| Id outside the fixture space | `fixture-id-space` |
| Label loses the marker | `marker-on-every-row` |
| Dangling foreign key | `foreign-keys-resolve` |
| State cites an undefined row | `required-state-covered` |
| Credential-shaped value in `syncState` | `no-provider-credential` |
| Undeclared non-marker tenant slug | `reserved-identifier-declared` |
| Conditional state with no explanation | `conditional-state-explained` |
| Non-loopback `DATABASE_URL` | seed refuses unless explicitly acknowledged |

The seed refuses any non-loopback database unless
`ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB` is set to an exact acknowledgement string,
because cleanup is destructive within its own tenants.

---

## 8. What downstream sessions consume

| Session | Consumes |
|---|---|
| 3.5 | `ENGAGEMENT_PHASE3_FIXTURE_FILE` key → id index; the anchor; `--apply` / `--cleanup` as harness lifecycle |
| 3.6 | Meetings, prep/notes/debrief/tasks/attachments, notetaker statuses, `absent.meeting`, `meeting.otherTenant` |
| 3.7 | Every outreach record, the draft artifact/version lifecycle, and §5.2's delta rule |
| 3.8 | Report targets and cycles (with §5.1), the four connection states, the empty second tenant |
| 3.10 | The seven actors, the walled client, both impersonation sessions |
| 3.14 | This catalog, the generated contract, and the negative controls |

---

## 9. Regenerating

The contract is generated and `--check-contract` fails if the committed copy
differs from a fresh build, so it cannot drift from the plan it describes. Adding
a fixture means editing the plan module and regenerating — and the suite then
fails until the new row is marked, id-spaced, reachable by a state, and covered by
cleanup.
