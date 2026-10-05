# Krisp Notetaker pilot release qualification

## Deployment result

Deployment completed on October 5, 2026. The release operator verified the exact
running images and actual task load-balancer health for API revision **555**,
Engagement API revision **131**, and Web vNext revision **392**. Each service's
manifest, qualification and promotion receipt is retained here. The production
database receipts confirm both pilot flags, unchanged other-tenant settings,
preserved prior migration history and successful application of the two pending
migrations. The live `os.capiro.ai` runtime config serves the exact source SHA;
the page and web health endpoint return 200, and the unauthenticated Krisp route
returns 401. Worker startup registers the Krisp controller and reports no sweep
warnings at the recorded check. These checks do not authenticate a Krisp account.

The owner requested implementation, merge and AWS deployment with access limited
to `capiro-internal` and `c2-strategies`. PR #2000 merged as
`be4d886ffa774f72e0ed5c5268995109cbd11220`. This record separates image/database
qualification from service promotion and from authenticated Krisp acceptance.

## Candidate and validation

`builds.json` binds all three native ARM64 images to that exact source and their
immutable ECR digests. The existing AWS CodeBuild project was used after GitHub
Actions returned startup failure without running jobs. The recipes use canonical
Dockerfiles, publish only SHA tags, and do not update services. Engagement uses
the Dockerfile's supported `NODE_VERSION=22.23.3` argument, matching API and the
locked dependencies' Node requirement. Packaged offline imports of the Krisp
service, worker, connector and worker module pass in both backend images. All
454 packaged migration files match source checksums. The web package contains
the Krisp UI and passes the production TypeScript/Vite build.

The 154 focused backend and 11 UI tests pass. Their tested feature commit has
identical application/package sources to the merge commit. API/web TypeScript,
Prisma validation, disposable PGlite isolation/uniqueness tests and mocked
desktop/mobile UI checks also passed during implementation. On the merge source,
the existing six web release suites pass (41 tests), as does the attachment-kind
compatibility test (one test). Test logs are retained beside this report.

## Database, retirement and rolling compatibility

`rehearsal.json` records actual Prisma migrate deploy runs against an isolated
local pgvector/PostgreSQL 16 container. A fresh 454-migration database passes with
every migration identity and checksum verified. A supported post-retirement
453-migration baseline upgrades with the new Krisp migration, preserving all
prior ledger rows. Retired Meri-agent and LegiWatch saved-view tables remain
absent. Both new tables have forced RLS, user-and-tenant policies, and app CRUD
grants. Synthetic fixtures verify only the two authorized slugs receive the flag
and other settings remain intact. The narrower PGlite test also exercises actual
cross-user/cross-tenant denials and duplicate prevention.

The first rehearsal attempt was interrupted by the local WSL instance stopping;
it is not counted as a pass. The successful rerun held its owned database process
alive. Initial API/worker builds were stopped to correct a release recipe's
migration-count assertion from 453 to the actual 454; the successful replacement
builds and their exact identities are in `builds.json`.

The existing served API has 452 source migrations. Main also contains the already
merged Excel attachment constraint expansion. The release runner allows only
that migration and Krisp to be pending. Both are additive/backward-compatible:
Krisp creates new tables and adds the two pilot flags; the Excel constraint
retains all previously accepted kinds. Application rollback retains the schema.
The old service images ignore the new tables/flag. The new web UI exposes Krisp
only when the API advertises it. Promotion order is API, engagement worker, web.

The runtime graph adds the existing controller-free managed MCP module and the
Krisp service/worker. It does not restore retired Hermes runtime modules or
reference dropped persistence. Offline imports of the actual image graph pass.
Current OAuth, encryption, generation and worker-owner settings are retained;
Engagement API is the sole background owner. Existing Recall behavior is covered
by the focused notetaker tests.

## Production procedure and acceptance boundary

The database task uses existing migration-secret references and the API network,
without exposing credentials. It verifies RDS TLS, checks the exact preflight
ledger fingerprint, permits only the two known pending migrations, runs the
candidate image's Prisma migration engine, and checks prior ledger preservation,
forced RLS/grants, both pilot flags and unchanged settings for all other tenants.
The migration connection explicitly sets `app.bypass_rls=on` for the authorized
tenant flag update; a Prisma query verifies that option before migrate deploy.
This is a session setting on the one-off migration, not an application role change.
Connection options are supported by the [Prisma PostgreSQL connector](https://docs.prisma.io/docs/orm/v6/overview/databases/postgresql).
No manual migration-ledger edits, template seeding, or down migration is used.

Service promotion uses `scripts/meri-release.mjs` and exact digest-bound
qualification, preserving all live service settings. Database and promotion
receipts are retained with this record when each operation completes.

Live Krisp OAuth/tools/transcript acceptance is **not yet verified**. A pilot user
must connect their own Krisp account, enable imports and capture a new meeting.
Krisp's [integration guide](https://help.krisp.ai/hc/en-us/articles/25416400191004-Krisp-MCP-Integrating-your-own-MCP-client)
currently lists Core Plan users as eligible for MCP access.
The adapter fixtures are representative, not captured authenticated provider
responses. Unsupported live schemas fail closed. Meeting/client routing reuses
the matched owned Capiro meeting and its current client assignment; ambiguous
matches require explicit meeting selection, and an unassigned meeting does not
gain an inferred client from the transcript.

Reviewed by the implementing release agent under the owner's explicit merge and
AWS deployment instruction. This does not assert an independent human review or
a completed customer sign-in/import acceptance test.
