# Client Portfolio onboarding: backend implementation plan

Status: proposed implementation plan; no migrations, routes, jobs or model calls
are executed by this PR. Implement only in `neo-capiro/capiro-backend` with UI in
`neo-capiro/capiro-frontend`; do not use `capirov2`.

Reviewed backend baseline: `backend-import` at
`471e3451b48674d881b395b354ea5b1292b698ca`. Frontend baseline: `main` at
`36359c4868ce95cddd48439f2524555b4cfd004f`. The frontend companion,
`docs/plans/portfolio-onboarding.md`, maps the complete 2026-11-03 attached
handoff to phases, Figma 3.4, screens, validation and acceptance criteria.
The PR starts from `4254a1cd7e5933197065bb698a5600288af65121`; the intervening
DIBBS change was reviewed and does not change the profile models/services here.

## Preserve the existing execution and domain owners

The handoff explicitly proposes reusing the old fill pipeline, and that is the
implementation decision. Remove Fill with Meri as a standalone feature while
retaining and adapting its useful execution machinery. Do not create a second
research engine, queue, conversation authority or client database.

| Observed code/model | Reuse or extension |
| --- | --- |
| `apps/api/src/clients/client-profile-fill-workflow.service.ts` | Durable source tasks, partial results, requested-source selection, review and resumption. |
| `client-profile-fill-run-create.ts` and `client-profile-fill-execution.ts` in the same directory | Request ID idempotency, active-run lock, run/task deadlines and authorization checks before writes. |
| Existing `client_profile_fill_run`, `client_profile_fill_task`, `client_profile_fill_extension_task` and finding persistence | Preserve staging, historical runs, rejection and retry state. Active historic table names are not dead code. |
| `client-profile-fill-profile-discovery.ts` | Reuse district-nexus discovery and its read-only facility district preview; only approved findings become canonical records. |
| `client-facilities.service.ts`, `facility-geocode.util.ts`, `external/census-geocoder/census-geocoder.client.ts` | Extend existing facility/geocoding owner rather than creating a parallel `client_location` table. |
| `ClientTarget` / `client-targets.service.ts` | Extend parent client-office relationship; add capability-support children. |
| `ClientCapability` and existing fit/attachment relationships | Extend lifecycle, review/provenance, alignment and tracking associations. |
| `BusinessDevelopmentProspect`, `business-development.service.ts`, `prospect-conversion-receipts.ts` | Preserve separate prospect ownership and the existing conversion/receipt transaction. |
| `knowledge/entities/universal-entity-resolution.service.ts` | Reuse entity-resolution tiers and canonical identity rather than a name-only matcher. |

Names without a directory in the table refer to `apps/api/src/clients/`, except
business-development files under `apps/api/src/business-development/`.
Existing Tango-specific `ClientProfileEnrichmentCandidate` has separate source,
field and consent restrictions; do not repurpose or remove those protections.

## Shared subject and facts

Add a shared typed subject `{ kind: 'client' | 'prospect'; id: UUID }` to the
profile-build service boundary. Keep the existing Client and
BusinessDevelopmentProspect records as their respective owners. Do not create
Client records as a workaround for the pipeline's current client-only FK.

Extend staged runs/findings and new fact/candidate records with `tenant_id`,
nullable `client_id` and `prospect_id`, an exactly-one-owner constraint and
tenant-aware foreign keys. Keep client rows compatible during expansion.
All run lookup, replay, rejection keys, source access and caches must include
subject kind/ID. A client UUID and prospect UUID are not interchangeable.
Add a prospect authorization adapter using the existing prospect owner rules;
do not weaken `requireOwnerClient` to accept an arbitrary identifier. Recheck
subject access when workers resume and immediately before applying findings.

Proposed persistence additions/extensions (final migration names may follow the
repo's conventions):

| Record | Required data and invariants |
| --- | --- |
| `client_fact` | Shared subject, typed field/value, source type/URL or attachment, evidence, observed time, confidence, status, approved actor/time, superseded fact, finding/run ID and entity identity. Every value retains provenance. |
| Fact conflict | Current and proposed fact IDs, field/version and resolution actor/time; person-entered values cannot be replaced without explicit resolution. |
| Entity candidate | Subject, legal name/domain/official IDs, evidence, score, chosen/rejected state. Alias and parent/subsidiary relations attach to canonical identity where appropriate. |
| ClientFacility extension | Role/status/country, source evidence and freshness, verified address precision, geographic version, economic-impact fields, capability links; retain existing coordinates, candidates, district fields and retry behavior. |
| ClientTarget extension | Relationship status, owner, last contact, next step, stance/history; child support links include capability, source, approval and stance history. |
| Capability extension | Named capability type, lifecycle/review status, provenance and family tags; use existing documents, PE fields and fit relationships. |
| Tracking association | Client-level links remain; add capability-to-item/approved-term associations and capability-scoped dismissals with restore. |
| Statement/recommendation evidence | Canonical office/term, statement date/source/allowed excerpt, evidence pointers and recommendation version/review state. Reuse an existing source record if semantically identical. |

Applying a finding writes fact history and the existing profile projection in
one transaction. Use expected versions and unique apply keys to prevent double
approval or stale overwrites. Person entry creates an approved person-origin
fact; research cannot auto-supersede it. Rejection memory is entity/field/value
or candidate specific and survives retry and refresh; explicit restore is audited.
Backfill existing data as legacy origin when evidence is unknown. Do not invent
source URLs, confidence, observed dates or approvals during migration.

Auto-accept only allowlisted facts with authoritative evidence and an exact
resolved entity/identifier: UEI, CAGE, SAM status, matched LDA filings and awards.
A matching display name, a model's confidence, or an unofficial page is
insufficient. Conflicts always require review. Capability, inferred alignment,
relationships and economic impact are proposals. Existing consent and
field-specific application restrictions continue to apply.

## Claude Agent SDK boundary

Current `client-profile-fill.service.ts` contains `callOpenAiJson` and
`callAnthropicJson` with direct Responses/Messages HTTP calls, including
classification/extraction paths. Replace every such call reachable from the
new workflow with a single bounded Claude Agent SDK integration owned here.
Use the SDK harness and structured outputs, not a custom tool loop wrapped in
an SDK-shaped function. The existing durable worker owns scheduling and retries;
the SDK invocation owns one bounded inference task.

- Pin the supported SDK version in the implementation PR and lockfile. Use the
  repo's validated server-side configuration and direct Bedrock task IAM model
  access. Never embed provider credentials in UI or logs.
- Provide explicit task instructions, an allowlisted read-only tool set,
  structured output schema, maximum turns/cost and timeout/abort handling.
  Source documents are untrusted data, not instructions or permission to act.
- Tools may retrieve approved sources but may not create clients, approve
  facts, send messages or mutate relationships on the model's authority.
  Application services validate and persist proposals; human approval remains
  a separate authorized transaction.
- Validate output schema, entity binding, evidence/source pointers and allowed
  fields. Reject unsupported claims, malformed output and absent evidence.
  Store provider/model/prompt/schema versions, usage, duration and outcome on
  the existing task audit with sensitive-content redaction.
- Run ID/task attempt idempotency, cancellation and write fencing remain in
  the current pipeline. A late SDK result cannot write after cancellation,
  timeout, permission loss or a superseding attempt.
- Surface a source/task error when the SDK is unavailable; do not silently
  fall back to raw HTTP provider calls. Deterministic official-data fetches and
  geocoding remain ordinary services, without LLM involvement.
- Audit transitive callers: identity ambiguity summaries, profile extraction,
  manual code suggestions, capability discovery/alignment, statements,
  recommendations and member-view synthesis all obey this SDK boundary.

The existing `@openai/agents` dependency alone does not prove this workflow uses
an agent SDK. Claude Agent SDK is the selected implementation; do not ship two
providers or leave the replaced raw helpers as unused fallbacks. Do not remove
a shared provider package still used by a separate active feature.

## Location-to-district resolution

The current service already uses Census address geographies, records the
congressional district's Congress, handles ambiguous matches, and has a precise
ArcGIS-address fallback. Retain that owner and its bounded request/retry path.

1. Normalize a sourced physical street address or user-verified map point.
   Keep source evidence, country, site role/status and verification separate.
   A job posting can propose a site, but cannot confirm an operating facility.
   PO boxes, city-only and ZIP-only input require an address; do not geocode
   centroids and present the result as the facility's district.
2. Resolve a US address with Census `/geographies/onelineaddress`. Return
   ambiguous candidates for review instead of choosing the first. Preserve the
   matched address, coordinates, precision and provider response evidence.
3. Reuse the existing ArcGIS `findAddressCandidates` fallback for no Census
   match: existing acceptance is score >= 90, PointAddress/StreetAddress and
   exactly one acceptable result. Resolve that point using Census coordinate
   geographies. Mark interpolated StreetAddress precision distinctly; a vendor
   score is not a probability of district correctness. The existing total
   request budget is 25 seconds; preserve bounded execution and partial failure.
4. Resolve federal congressional, state lower and state upper districts for
   the requested boundary version. Discover the applicable official layer and
   identifiers; do not hardcode a MapServer layer number or assume one chamber
   shape. Keep state FIPS, district GEOID, Congress/chamber, provider, benchmark,
   vintage, geometry version, effective dates and resolved time.
5. `Public_AR_Current` / `Current_Current` are moving labels. Pin or validate
   their returned version against the requested serving Congress. Official
   TIGERweb currently exposes distinct 119th and 120th Congress layers. If the
   geocoder lacks the required vintage, use the official boundary layer for
   point-in-polygon resolution; do not silently pair a 120th district with a
   119th office. Revalidate revisions before release.
6. For a low-precision or boundary-adjacent result, require a verified point or
   manual review before assigning an office. Retain all candidates/uncertainty.
   Do not fabricate accuracy radii or LLM-generated district confidence.
7. Join House districts to the official office directory for the same term;
   senators resolve from state, and state legislators from chamber district
   and term. Preserve at-large `00` and official territorial codes. Missing
   office data is an unresolved office, not a made-up representative.
8. Cache by normalized address/verified point **and boundary version**, not
   address alone. Boundary or address changes schedule re-resolution and mark
   derived links stale. Keep previous history and human overrides; surface a
   conflict if new derived results disagree with an approved override.

Return `resolved`, `needs_address`, `ambiguous`, `source_unavailable`,
`not_applicable` or `stale_boundary` plus site verification status, candidates,
source and geographic version. International facilities have no US district.
Facilities remain saved when geocoding fails. Preview is read-only; applying an
approved finding performs the canonical write. No live API calls are required
for deterministic district fixtures.

## APIs, conversion and cutover

Proposed neutral route families are `clients/:clientId/profile-build/...` and
the existing prospect resource's `:prospectId/profile-build/...`. Keep typed
subject routing on the server; do not accept a tenant ID from the browser.
Map current setup, run start/latest/get/cancel, task retry, review/apply,
reject/restore and refresh operations to the shared service. Preserve request
IDs, expected attempts, selected sources and explicit document-only requests.
Align frontend schemas and actual controller contracts before rollout.

Current `clients/:clientId/fill-with-meri` also owns refresh schedule and
advocacy-history/health endpoints. Inventory all consumers: retain these active
capabilities under neutral owners/routes, migrate callers and proxy policies,
then remove the old controller route family. No permanent alias or dead
compatibility controller. A temporary rollout adapter, if required for deployed
clients, must have an owner, observed caller cutoff and deletion in the cutover
series before the work is complete.

LDA imports retain official IDs, issue codes and filing provenance. Enforce 100
selected clients, same-tenant duplicate resolution, idempotent per-client
requests and canonical slot admission for every actual new Client creation.
Keep item outcomes durable when another item is ambiguous or unavailable.

`convertInTransaction` already locks the tenant-owned prospect first, resolves
an explicit or canonical existing client before creating one, uses
`ClientsService.createInTransaction` for slot admission, and writes audit in
the same transaction. `convertCommand` adds replayable receipts. Extend these
owners; do not introduce a second conversion endpoint or billing path.

Within that transaction, copy/link reviewed facts, source references, notes,
contacts and attachments with stable origin IDs and uniqueness rules. Preserve
the prospect and its activity history. Resolve conflicts against an existing
client without overwriting person entries. Pause or fence active prospect
research during conversion, then explicitly rebind eligible pending work;
prevent a racing result from applying to both subjects. Keep original run and
approval provenance. Schedule post-conversion research after commit only, with
the existing created-vs-linked semantics and no duplicate replay scheduling.
Test rollback on capacity refusal and conversion receipts after lost responses.

## Relationships, capabilities and migration

Extend ClientTarget rather than replace it. Its current uniqueness on
`(clientId, memberId)` must be checked against congress/state/staff directory
namespaces and term identity; migrate to a collision-safe office key before
mixing these domains. Child capability-support links require tenant/client
matching with both the parent and capability. An approved recommendation
upserts the parent and child atomically; a client-only link remains valid.

Keep existing client-level tracking. Add capability-specific associations only
when the target is known; do not assign every historical item to every
capability. Only approved alignment terms feed active tracking, with PE/program
approval separate from tags. NAICS/PSC remain classification data. Dismissals
are capability-scoped; rejection/restore and refreshed recommendation versions
are durable. Exact source statements and licensed excerpts are stored under
the existing ingestion controls, not copied wholesale by a model.

Typed sector anchors support defense PE, health agency account/program and
agriculture program/Farm Bill title. Keep proposed reference rows unconfirmed
until practitioner review. The source package's reference-data drafts are not
included; do not fabricate them or ship placeholder company/member records.

## Delivery, deletion and verification

1. Expand schema and subject-aware contracts; backfill legacy origin honestly;
   add fact apply/conflict and SDK adapters with source fixtures. Verify existing
   client runs still resume. Use additive forward migrations, preserve immutable
   applied migrations, and rehearse recovery against representative existing
   rows, including constraints and indexes.
2. Enable the unified entry/build/manual/LDA/prospect flow behind one owned,
   expiring flag. Migrate callers and the standalone feature's active services.
   Rollout rollback disables new entry while preserving saved data and runs.
3. Remove replaced UI/controller paths, duplicate raw LLM helpers, unused DTOs,
   module registrations, exports, styles, fixtures, tests and configuration.
   Retain needed migrations/audit history and active shared tables. Inventory
   imports and dependency users before removing packages/lockfile entries.
4. Complete capability/alignment/tracking, relationships/recommendations and
   impact/sector phases with the frontend acceptance matrix. Remove the rollout
   flag and unreachable alternate branch once adopted.

Implementation gates (all pending; this plan does not assert test passes):

- Tenant isolation and authorization on start, get, retry, review, refresh and
  resumed workers; no restricted-client disclosure through duplicate detection.
- Run/request idempotency; stale attempt fencing; cancellation; partial source
  failure; document-only selection and review version races.
- Provenance-preserving apply, person conflicts, official exact-ID auto-accept,
  rejection memory, restore and legacy backfill without invented provenance.
- SDK structured-output errors, budget/timeout/abort and forbidden mutation
  attempts; static audit for reachable raw Responses/Messages/other LLM calls.
- District fixtures covering exact/multiple/no matches, fallback precision,
  boundary adjacency, missing street, PO box, international, at-large and
  territorial codes, state chambers, Congress/version mismatch and cache invalidation.
- Conversion concurrency, lost-response replay, existing-client link, capacity
  refusal, mixed-subject UUIDs, active-run fencing and complete carry-over.
- Atomic parent/support approval, same-client FKs, directory key collisions,
  ethical walls, approved-term-only tracking and per-capability dismissals.
- Run repository typecheck/lint and affected API/unit/integration suites with
  the repo's pinned tooling; rehearse migrations. Do not claim the attachment's
  historical baseline failures as current evidence or weaken existing tests.
- Regenerate the runtime closure contract and Prisma pins in the owning
  implementation PR whenever package manifests, lockfiles or Prisma schema
  change, as required by AGENTS.md; preserve qualification probes.
- Search both repos for the old feature strings/routes, dialog symbols,
  orphan exports and direct model calls. Explain every retained active/history
  hit; no obsolete runtime code, permanent route shim or disabled duplicate
  implementation may remain at completion.

## Design and authoritative references

[Figma 3.4 onboarding components](https://www.figma.com/design/mpXWnySldUFzdVna8i69Ki?node-id=3173-85786)
contains 17 editable component families / 57 variants, including seven location
resolution/site states. The frontend plan maps their nodes and remaining page
composition work.

References reviewed for the proposed SDK and geographic design:

- [Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)
  and [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs).
- [Census Geocoding Services API](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html).
- [Official TIGERweb legislative layers](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer).

This documentation review used current source and schema from the two specified
repos. No runtime code was changed, no deployed routes were removed, and no
production research or database mutation was performed by this PR.
