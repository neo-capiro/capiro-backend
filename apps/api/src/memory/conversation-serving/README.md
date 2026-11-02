# Conversation-derived memory after restore

`withMemoryConversationRetention` composes with the existing tenant/user Prisma
transaction. Candidate, memory-review, inbox, notification projection, Settings
submission, immutable-version and Meri receiving owners use this shared boundary.
The trust aggregate and generic-review compatibility check use it when consulting
memory proposals. Helpers borrowing one of those transactions do not open a
second transaction. Authorization, membership, client walls and memory grants
remain with their existing Core owners.

The client reads the content-free native witness over the existing private control
listener using `MERI_CONTROL_ORIGIN` (an HTTPS origin) and
`INTERNAL_SERVICE_SECRET`. It bounds fetch and body reads, rejects redirects and
unknown wire fields, and never caches a witness. No subject or customer content
crosses this endpoint. An absent or invalid response is a missing proof, not
permission to serve a conversation-derived copy.

The forward migration `20281029200000_memory_restore_serving` requires an
ordinary application role and enabled, forced RLS. Its replacement of the existing
conversation predicate checks the Core bootstrap binding and calls
`meri_core_authority.retention_serving_v1`. Meri's integration phase 71 installs
that predicate under the existing non-login `meri_core_admission_reader` role.
Core receives function execution, never raw native table access. No new retention
ledger or authorization framework is introduced.

The native predicate tries the canonical shared conversation-transition lock,
then the shared recovery lock. It compares the database watermark to the external
position, checks native conversation ownership and the current suppression row.
Try-lock refusal avoids waiting behind a purge that already owns transition
exclusion and is calling Core cleanup. Locks last until transaction completion.
If any conversation proof was used, the helper obtains another external witness
and requires the exact same sequence and hash, then verifies the database again.
Unavailable or changed proof rolls back writes and returns
`MEMORY_RETENTION_UNAVAILABLE` (503) before releasing results.

Approved/auto-committed memory and independent surface memory keep their own
retention policy. They do not require a conversation witness; their ordinary
authorization still applies. Generic deliverable reviews exclude memory before
fetching content. Trusted cleanup remains on the existing system transaction.
Learning-signal candidates have independent provenance; published-memory
projection and lineage checks retain their existing owner. They do not acquire
conversation-derived content outside the guarded owners.

Deployment must coordinate the existing native witness endpoint, native
integration phase 71 and the Core forward migration/application. Install the
native predicate before admitting the new Core path. During the Core
migration/application transition, stop old candidate/review serving; old readers
cannot supply the required proof. Native startup/readiness performs recovery;
the witness endpoint never reconciles while a caller may hold a recovery lock.
Missing prerequisites refuse conversation-derived serving, rather than falling
back to a restorable Core conversation. This source change does not deploy any
component or resolve the separate legacy content-bearing receipt disposition.

Validation uses synthetic records on a task-owned PostgreSQL database and the
ordinary `capiro_app` role. `transaction.postgres.spec.ts` covers the actual
candidate service, candidate/review/notification suppression, cross-tenant and
native-owner refusal, stale/missing proof, activation rollback, lock contention,
forced RLS, restricted native grants, cleanup and independent memory. It applies
the native installer body twice to prove retry after an uncertain phase commit.
`witness.spec.ts` covers bounded transport and wire validation.
`witness.integration.test.mjs` imports the actual native private route and
retention startup in tests only; it demonstrates restored-away suppression and
recovery across the Core consumer/native producer boundary. Run it with Node 24
and `MEMORY_RETENTION_NATIVE_SOURCE` pointing at the paired native checkout.

Existing domain unit tests retain their business assertions using the test-only
`unit-boundary.fixture.ts`; SQL enforcement is qualified against PostgreSQL, not
approximated by query-specific unit doubles. These tests do not establish
deployed recovery or a production database role/configuration.
