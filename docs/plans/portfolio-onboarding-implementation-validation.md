# Portfolio onboarding: backend implementation and validation

The standalone fill entry now uses a shared profile-build flow for clients and
prospects. It retains the existing durable run/task/finding machinery and the
canonical client, prospect, facility, capability and relationship owners. This
implementation is confined to `neo-capiro/capiro-backend`, with its caller
cutover in `neo-capiro/capiro-frontend`; `capirov2` is outside scope.

The combined implementation covers the handoff's phases 0–9. The original
[backend design](portfolio-onboarding-backend.md) remains the requirement map.
This is a source implementation and review record, not deployment qualification;
the validation table separates local evidence from unrun live checks.

## Implemented paths and ownership

| Handoff slice | Backend implementation at this checkpoint |
| --- | --- |
| Phase 0: foundation | Typed client/prospect subjects; tenant-qualified ownership; versioned person/research/official/legacy facts; explicit conflicts and rejection memory; existing durable task deadlines, leases, retry identity and cancellation fences; bounded SDK source extraction. |
| Phases 1–3: entry, build, manual, LDA, prospects | Pre-subject identity/reference endpoints; shared setup/start/latest/review/apply endpoints; canonical manual projection; searchable official code snapshots; durable LDA import and pending website inputs; six-section prospects and atomic conversion carryover. Exact-identifier official acceptance; fresh-source identity confirmation across SAM/LDA/SEC/web/document candidates; quoted aliases/relationships; pre-save NAICS/PSC/LDA suggestions requiring individual acceptance. |
| Phases 4–5: capabilities and alignment | Existing capability store extended with lifecycle/provenance; typed proposals, reviewed terms, document associations and capability-scoped tracking. Source findings stage under the existing task fence. Automatic scoped PE/program/grant/classification alignment, annual-report business-unit discovery, and source-backed updates to existing capabilities run through the existing fenced worker. |
| Phases 6–7: offices | Parent relationships and capability-support children; directory/member/term identity; sourced statements and embeddings; bounded official-source fit, active owner suggestions and caution; preserved review decisions; source-driven refresh through the existing profile worker. Generated support stance is unknown until a person records actual interest/support. Source review and scoped tests passed; combined validation is recorded below. |
| Phases 8–9: impact and sectors | Canonical facility impact/evidence fields, reviewed case fields and typed sector anchors. Unconfirmed source drafts remain reviewable drafts; missing references are not invented. Prime-unit production uses approved unit identity and exact official recipients. |

The active prefixes are `/clients/:clientId/profile-build` and
`/business-development/prospects/:prospectId/profile-build`. Both expose setup,
runs, latest, cancellation/retry, review/application, rejection/restore, profile
read/save, identity confirmation and conflict resolution. Static
`/clients/profile-build/identity-preview` and `/clients/profile-build/references`
and `/clients/profile-build/identity-confirm` work before a subject exists.
Document-first entry uses the existing attachment owner: upload privately, read
current owner-authorized bytes without paid extraction, confirm actual sourced
company identity, create once, then link that same attachment ID. Sharing is an
explicit unchecked choice; private documents never start shared profile research.
Website-first entry likewise requires an actual quoted company name.

Existing client refresh/advocacy consumers use
the neutral prefix. There is no permanent old-route alias or duplicate runner.

Responses identify the subject explicitly; prospect responses do not masquerade
as clients. An explicit `sources: []` remains document-only. Saved source and
identity selections, request IDs, retry attempts and review revisions remain
binding. Manual section arrays add/update supplied rows; canonical section
routes own deletion. Omission is not reported as deletion.

## Acceptance, evidence and conversion

Exact official acceptance is narrowly allowlisted. UEI, CAGE and SAM status use
the existing read-only `VendorReferenceSamClient` exact-identifier lookup.
Matched LDA filings use current confirmed LDA IDs. Federal awards and assistance
use existing ingested records with an exact recipient UEI, without name
fallback. Anchors come from saved, verified canonical identifiers or current
person/official identifier facts, and are rechecked under the subject lock.
Name matches, NAICS/PSC suggestions and inferred capability/relationship facts
remain review items regardless of confidence.

Automatic fact history, canonical projection, finding acceptance and audit commit
inside the existing fenced source transaction. Facts use `origin: official`,
null human approver and `evidence[].metadata.acceptanceMode: exact_identifier`;
findings retain the compatible `accepted` status. A conflicting person value
remains current. Same-source automatic refresh can replace a prior automatic
value, but cannot silently replace human authority. “Not right” remembers the
rejection and reverses a projection only while that automatic fact is current;
a later person edit survives. Restore returns the item to human review.

Shared profile publication requires currently available, all-viewer documents.
Readers recheck evidence availability, including original prospect access for
converted document links. Inaccessible pending facts, findings and conflicts
are omitted. Explicitly published canonical values remain after source withdrawal,
while unavailable excerpts, URLs and nested provenance are redacted. Replayed
save receipts return a fresh authorized snapshot. Recorded source timestamps
are preserved separately from approval time.

Conversion uses the existing transaction, capacity enforcement and durable
receipt. It carries approved facts, origin/evidence, notes and pending review;
remaps child IDs; links existing attachments without copying S3 objects or
broadening ownership; cancels old prospect attempts; and creates successor
client tasks in the same transaction. An already active client run returns a
recoverable conflict. A crash cannot lose successor research intent. The
original prospect remains available as history.

Physical attachment deletion cascades only attachment links. The fact foreign
key uses column-scoped `ON DELETE SET NULL (attachment_id)`; immutable evidence
retains the original source identity and reads mark it unavailable. Approved
fact history is not deleted with the source file.

## Phase 7: statements and recommendations

`PortfolioRelationshipsService` composes the existing office ranker, proposal
store and canonical relationship owner. The office key includes the canonical
`congress:N` term; a current-office recommendation requires a currently serving
member in that Congress. Statement proposals retain their actual statement
term and date, summary, tags, press identity and dated source evidence.

The statement producer reads canonical `MemberPressItem` rows. Only dated,
recent official sources enter this producer; social-only material does not
establish a recommendation. `EmbeddingsService.embedMemberStatementImmediate`
uses the existing provider contract and `context_embeddings`, with
`source_type=member_statement`. Its global input is only public canonical press
identity/date/title/URL/summary, never client tags or private documents. The
write guard locks and compares the complete, untruncated source identity after
provider work and rechecks current client authority and the active task. An
unchanged content hash reuses the existing embedding. No new embedding store
or raw LLM caller was added.

Capability fit uses visible approved capability terms, excluding NAICS/PSC.
Whole-client fit also resolves canonical client LDA issue codes to their
reference names, so a capability is not required. Available signals include
reviewed official statements; current sponsorship and nonwithdrawn
cosponsorship; verified committee/subcommittee jurisdiction; official hearing
titles tied to the member's committee; and retained NDAA/defense-appropriations
passages read through the existing immutable bill-text search/read owner.
Quoted bill passages must pass that owner's extraction/hash checks.

Geographic fit requires a verified operating site, a resolved precise current
boundary without review/adjacency flags, a recognized House/Senate office,
matching authoritative state FIPS and, for House offices, the same district.
US territories follow the canonical geocoder's ISO2 eligibility. Missing,
ambiguous, stale or unverified location evidence cannot support a geographic
claim. The evidence labels the result as a verified facility/boundary record,
not a statement by a member.

Each generated proposal includes dated linked evidence, rationale, an ordinal
fit rating, an entry point and a why-not line. Fit counts the breadth of sourced
signal types; it is not a probability, endorsement or promised support. Active
existing relationship owners take precedence over active ordered account
owners; no owner is invented when neither is available. Existing next steps,
recorded declines, last-contact dates and stale observation dates inform the
caution and entry point. Approval creates the required parent and capability
association together. A new parent is Planned; an existing relationship status
is preserved. Generated support remains `unknown` until a person records an
evidenced stance. The forward migration preserves every existing stance and
changes only the allowed values and default for future support rows.

Source refresh updates only untouched generated pending proposals, using a
version compare and appended source-revision history. Approved, rejected,
restored/person-edited and legacy pending proposals are not overwritten or
resurrected. Rejection remains a durable review decision.

Automatic refresh is owned by the existing profile-worker sweep. At most once
per minute it pages ten clients with a prior completed/partial `bill_tracker`
research run, hydrates the actual requester's current membership, role, Clerk
identity and tenant, and invokes the existing `startRun` owner with a stable
request UUID. The revision covers ingested press, bills/cosponsors, immutable
federal evidence, hearings and committee data, plus relevant approved local
terms/statements. Existing run identity provides replay across processes and
restarts; failed/cancelled work keeps the normal retry/review owner. The durable
`bill_tracker` task refreshes whole-client and established capability scopes.
Both the ranking-cache transaction and proposal transactions recheck current
access and task validity before returning. No GET/render path, new timer,
parallel queue, scheduler table or invented background actor was introduced.

The fan-in is bounded: twelve ranked current offices; up to twenty-four recent
press rows per office; bounded canonical bill/committee/hearing reads; and up
to three canonical signals per kind so a long sponsor list cannot crowd out
geography or committee evidence. Reviewed statement evidence has its own
eight-item bound. Full-text defense matching checks up to eight approved
phrases and eight candidate defense bills through the existing text owner.
A corpus change can schedule a check even when its eventual evidence does not
match a client's terms. Missing coverage remains a gap, not negative evidence
about a member. This producer does not claim exhaustive coverage of every
letter, floor remark, hearing transcript or older source in the public record.

## Migrations and configuration

Apply only through the integration owner's normal forward-migration process.
These local tests did not apply migrations to a native, preview or production
database.

| Migration | Change |
| --- | --- |
| `20290110010000_portfolio_subject_facts` | Expand existing fill persistence to exactly one client/prospect subject; add fact/conflict/candidate/link records, tenant/subject FKs, forced tenant RLS and honest legacy backfill. |
| `20290110020000_portfolio_capabilities_relationships` | Capability lifecycle/provenance; directory/member/office-term target identity; proposal, approved-term, capability-tracking and support children; compound FKs, wall-aware RLS, grants and review/version invariants. |
| `20290110030000_portfolio_geography` | Extend canonical facilities with site/source/precision/version/history/impact fields and same-client capability links. |
| `20290110040000_portfolio_import_inputs` | Nullable versioned `firm_import_jobs.request_jsonb` for selected pending websites; legacy request digests/null payloads remain compatible. Queue reads never approve websites or launch research. |
| `20290110050000_portfolio_capability_documents` | Typed same-client capability/attachment links, converted-source ownership checks, file-move unlinking, scoped backfill and wall-aware RLS. Its independent final combined migration gate is owned by integration. |
| `20290110060000_portfolio_unknown_support` | Forward-only expansion of the support-stance check/default to `unknown`; existing reviewed stances, histories, versions, FKs and indexes remain unchanged. |

The integration owner must regenerate the production dependency closure and
Prisma pins at the final schema/package head and record the combined six-migration
qualification. Do not edit an already applied migration during rollout.

| Setting | Current behavior |
| --- | --- |
| `@anthropic-ai/claude-agent-sdk` | Pinned `0.3.318`; prompt version `portfolio-evidence-v1`. |
| `PORTFOLIO_AGENT_MODEL` | Required for inference; choose an authorized Bedrock model in server configuration. Missing configuration reports source unavailability; there is no raw-provider fallback. |
| AWS region and identity | Existing task IAM chain. Region resolves from `AWS_REGION`, `AWS_DEFAULT_REGION`, then `AWS_REGION_DEFAULT`, defaulting to `us-east-1`. The isolated SDK child sets `CLAUDE_CODE_USE_BEDROCK=1`; provider keys/proxy URLs are not forwarded. |
| Task bounds | Defaults: 4 turns, USD 0.50, 90 seconds; hard caller caps: 8 turns, USD 2, 180 seconds. Worker deadline, cancellation and lost lease can abort earlier. |
| SDK tools | Selected-source `read_source` and structured-result submission only; no mutation tools, ambient settings or persisted session. Subject, schema, source pointers and verbatim evidence quotes are validated before staging. |
| `CENSUS_SERVING_CONGRESS` | Positive integer, default `119`; requested office term and resolved boundary version must agree. |
| `CENSUS_STATE_LEGISLATIVE_YEAR` | Integer from 2000 onward, default `2024`. |
| `CENSUS_GEOMETRY_VERSION` | Nonempty geometry label, default `BAS 2026`; participates in the boundary/cache identity. |

Geography retains the canonical resolver and precise fallback. The requested
boundary version participates in caching and official layer selection. Address
changes invalidate prior geometry/verified points through the canonical
transaction helper and schedule resolution after commit. PO boxes, missing
physical addresses, international sites, ambiguous results and unavailable
sources stay explicit. State districts can resolve independently; state office
terms remain unverified where the official directory does not supply dates.
Configuration and live provider behavior still require environment qualification.

Reference search uses pinned official snapshots: Census 2022 NAICS (1,012
selectable six-digit industries) and April 2025 PSC (2,344 active codes plus
1,310 retired identities for validation). There is no runtime catalog fetch or
model call. Format-valid out-of-list person entries are labeled unverified;
known retired PSC values are rejected.

## Deletion evidence and retained identifiers

Removed from `ClientProfileFillService`: the detached `startRun`/`executeRun`/
`executeCapabilityDocumentRun` closure, obsolete source normalization/latest-run
helpers, direct `callOpenAiJson`/`callAnthropicJson` paths and direct synced-mail
extraction superseded by the governed context owner. Matching factory wrappers
and tests for unreachable owners were removed or moved to the actual durable
owner. Relationship review now composes canonical association, audit and finding
acceptance in one transaction, with indexing after commit.

Retained `client_profile_fill_*` tables/files are the active durable machinery
and historical ledger. `crm.fill-with-meri` is the existing governed operation
identity used by context and evaluation. Immutable migrations retain historical
identifiers. Active client runtime labels, errors and comments use profile
research. These retained owners are live dependencies, not standalone routes or
disabled duplicate implementations. Tracked source searches find no direct raw
model calls in client workflow code and no retired product label.

## Recorded validation and remaining gates

| Check | Recorded result |
| --- | --- |
| Manual intake parser | 35 focused tests passed; targeted strict TypeScript check passed. |
| Official reference snapshots | 8 focused tests passed. |
| Foundation/relationship targeted run | 65 passed; one meeting pagination test failed identically on the untouched baseline. |
| Exact official acceptance | `profile-facts.pglite.spec.ts`: 20 passed, including actual migration SQL, automatic acceptance, person conflicts, rollback, source withdrawal, conversion and document deletion. |
| Official-source and saved-input contracts | `client-profile-official-sources.spec.ts` plus `client-profile-fill-research-inputs.spec.ts`: 15 passed. Name-only/ambiguous sources remain pending; explicit empty selections do not widen. |
| Phase 7 source production and worker guards | Eight focused suites / 46 tests passed at `9f962acf`; the `4db80fde` follow-up passed three affected suites / 36 tests. Independent source review found no remaining P1 after cache/task, full source-identity and neutral-stance fixes. Integrated production build passed as recorded below. |
| Phase 7 SQL fixtures | Actual auto-refresh SQL passed seven scratch PGlite checks. The `20290110060000` migration passed thirteen checks: preserved existing rows/history/version, default and explicit unknown, all prior stances, invalid/null rejection, FK/index retention and the exact expanded check. This is not native PostgreSQL qualification. |
| Integrated API production build | Passed on code checkpoint `48b0019f`: Node 24.22.1, pnpm 9.12.0, `NODE_OPTIONS=--max-old-space-size=5120 corepack pnpm --filter @capiro/api build`. Prisma generation passed. Full repository typecheck remains unqualified: earlier checks hit inherited dependency/test errors and the unchanged-base rerun exhausted the available heap. Backend lint dependencies are unavailable in this environment. |
| Integrated affected API suite | **102 suites / 1,309 tests passed** at `48b0019f`, using `--runInBand --runTestsByPath` across changed suites and durable-pipeline regressions (180.76 seconds). Includes actual PGlite fact, relationship, capability-document and import SQL tests; private upload, current actor/source, SDK, office, PDF and geography contracts. No skipped suites or failed tests in this run. |
| Independent review | Separate reviewers approved foundation/depth, geography/SDK, registration/identity, private attachment owner, Phase 7 and final provider wiring. Final identity review: 39 tests; private upload owner: 40 tests; final build fixes: 55 affected tests. No remaining P1 in the reviewed changes. |
| Runtime closure | Contract regenerated twice byte-identically; ARM64/x64 image-local Prisma hashes regenerated after the final schema. Musl-target tests passed. Earlier closure fixture failures reproduced on the untouched base; these results do not qualify a container image. |
| Native PostgreSQL, live IAM/model/provider, image and release gates | **Not run or qualified by this checkpoint.** |

Reproduce the latest official-source gate with the repository's pnpm 9.12.0:

```sh
corepack pnpm --filter @capiro/api run test --runInBand --runTestsByPath \
  src/clients/profile-facts.pglite.spec.ts \
  src/clients/client-profile-official-sources.spec.ts \
  src/clients/client-profile-fill-research-inputs.spec.ts
```

The inherited failure is `portfolio-a1.safety.spec.ts`, “does not offset past an
authorized row after a preceding row disappears during continuation”, failing
with `undefined.map` on both the implementation and unchanged baseline. It was
not hidden or weakened. PGlite executes PostgreSQL SQL locally in WASM; passing
it does not establish native PostgreSQL or deployed behavior. No production queries, live model runs or deployments were performed.
Companion pull requests contain the implementation for review.
