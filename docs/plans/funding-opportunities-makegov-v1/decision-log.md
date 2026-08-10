# Decision log — Funding Opportunities + MakeGov/Tango

Locked decisions, and any amendment to one. An amendment gets a new dated entry;
the original is never edited, because the reason a decision changed is usually more
useful than the decision.

Format: **D-nn** · date · decision · why · what it forbids.

---

## D-01 · 2026-08-06 · Local-first provider boundary

The request path must never call MakeGov/Tango. Data flows
`Tango API → scheduled/manual sync or verified webhook → provider-owned snapshots +
normalized local tables → deterministic Capiro services → APIs, UI, Meri tools,
alerts`.

**Why:** if Tango is unavailable, previously synchronized data must remain usable and
visibly stale rather than disappearing. A live provider call in a read path converts a
vendor outage into a Capiro outage, and converts a vendor rate limit into a user-facing
error.

**Forbids:** any user-facing endpoint whose response depends on a live Tango request.

---

## D-02 · 2026-08-06 · Source precedence, and no last-write-wins

For facts that already have a first-party rail (SAM.gov, Grants.gov):

1. Existing Capiro ingestion stays authoritative for canonical lifecycle fields.
2. Tango observations may verify, enrich, or identify a conflict.
3. A conflict is **recorded**. Neither source silently overwrites the other.

For provider-exclusive datasets (agency forecasts, DIBBS, SBIR/STTR), Tango is the
source, but the row still carries original source system, provider, fetched timestamp,
provider update timestamp, content hash, and source URL.

**Why:** a merge that picks a winner destroys the evidence that the two sources
disagreed, which is exactly the signal a government-affairs team needs.

**Forbids:** `last write wins` on any shared field.

---

## D-03 · 2026-08-06 · Provider-owned tables

Tango data lands in `tango_*` tables or explicitly provider-qualified columns.

**Why:** a Tango observation must never be able to read as a first-party Capiro fact.
Once the two are in the same unqualified column, no later query can tell them apart.

**Forbids:** writing Tango-derived values into `federal_grant`, `sam_opportunity`,
`clients`, or `client_intel_mapping` fields.

---

## D-04 · 2026-08-06 · No model-owned decisions

An LLM may summarize and explain evidence. It may not calculate eligibility, change
deterministic relevance, decide vehicle access, fabricate a contract value, turn
missing evidence into a negative assertion, auto-accept profile enrichment, auto-send
outreach, or auto-promote an outcome into institutional memory.

**Why:** every one of those is a claim a client will act on, and a claim that has to be
reproducible from source data on request.

**Forbids:** any code path where a model output is written to a decision field without
a human transition.

---

## D-05 · 2026-08-06 · Eight separate concepts, eight separate fields

Machine recommendation · relevance · eligibility · acquisition position · human
decision · workflow stage · source lifecycle · confidence. Never merged in the schema
and never merged in the UI. Confidence means evidence quality, **not** probability of
win.

**Why:** merging relevance with eligibility turns "you are legally barred from this"
into "this is a weak match" — the specific failure the two-field split exists to
prevent. The current `OpportunityCard` already renders them as two separate badges for
this reason.

**Forbids:** a single blended "fit score"; a confidence value presented as a win rate.

**Status at freeze:** relevance / eligibility / workflow stage / source lifecycle
exist. Machine recommendation arrives in P06, human decision in P07, acquisition
position in P23. The plan's §4.5 vocabulary (`reviewing`, `qualified`, `submitted`,
`monitor`, `pass`) does **not** exist in the codebase yet — see README §3.1.

---

## D-06 · 2026-08-06 · Security and SOC 2 posture

- API keys live only in Secrets Manager and ephemeral sync tasks. Never in a prompt,
  PR, issue, fixture, `.env.example`, log, or test snapshot.
- Every tenant-scoped new table: RLS `ENABLE` **and** `FORCE`, four tenant policies,
  explicit tenant predicates, cross-tenant negative tests.
- Standard users may operate pursuits. Mapping approval and provider configuration are
  admin-only. Client portal users get no Funding Opportunities access.
- External descriptions and attachments are untrusted data, isolated from instructions.
- Every state change writes an audit event **in the same transaction**.
- Rejected mappings and enrichment proposals stay rejected.
- Webhook raw bytes are verified before the JSON is trusted.
- Repair/backfill/sync commands are dry-run by default and idempotent.

**Why `FORCE` and not just `ENABLE`:** enabled-but-not-forced leaves the table owner
exempt, and migrations run as the owner. A PE Phase-C backfill silently no-op'd
earlier this month for exactly that reason.

---

## D-07 · 2026-08-06 · Every tenant-visible capability is separately flag-gated and dark by default

No flag has an implicit internal-tenant fallback. Flags control presentation and
behavior, not schema existence — new migrations may deploy while every flag is off.

**Why:** `DistrictNexusFlagGuard` treats the `capiro-internal` slug as implicitly
enabled, which meant merging it enabled the feature for a tenant. Turning something on
must be a reviewable flag write, not a side effect of a merge.

**Forbids:** a guard that reads tenant identity for anything except the flag row
itself. Enforced by a test asserting the guard source contains no `capiro-internal`,
no `CAPIRO_INTERNAL_TENANT_ID`, and no `FROM tenants`.

---

## D-08 · 2026-08-06 · Forward-only, expand-then-contract migrations

All migrations are forward-only and compatible with the previously deployed API/web
pair. Additive columns are nullable. No destructive DDL without a separately approved
contract phase. Every statement is retry-safe (`IF NOT EXISTS`, guarded policy
creation), because a failed migration blocks every later one.

**Why nullable is load-bearing, not laziness:** `source_fingerprint` is nullable
because null means "no baseline yet", which the lifecycle pass treats as a silent
first observation. A `NOT NULL DEFAULT` would make every legacy row look
already-observed and the first run would alert on the entire corpus.

**Forbids:** dropping `source_fingerprint` on rollback — that destroys every lifecycle
baseline. The documented rollback for schema is **do not roll back**; the flag is the
kill switch.

---

## D-09 · 2026-08-06 · The baseline is a fixture, not a snapshot

P00's frozen contract lives in `baseline-contract-v1.json` and is asserted against
typed static constructors, not `toMatchSnapshot()`.

**Why:** a snapshot is regenerated with `-u` by whoever broke it, which deletes the
review step that matters. A checked-in fixture has to be edited by hand, in the diff,
with a reason. Same logic applies to the CI test floors: they are mirrored in the
fixture so lowering one takes two visible edits.

**Why static constructors and not recorded responses:** a baseline captured from
production data freezes that data's accidents — a field that happened to be populated
that week — as though they were the contract.

---

## D-10 · 2026-08-06 · P00–P10 execute on one branch (deviation from §6.1)

Plan §6.1 requires one PR and one independent acceptance decision per micro-phase.
P00–P10 are instead being executed as sequential commits on
`agent/fo-p00-baseline-freeze`.

**Why:** explicit user instruction.

**Consequence, stated plainly:** the §6.2 independent-tester gate cannot run between
phases, so a defect introduced in P01 is not caught before P02–P10 build on it. Green
CI on this branch is not a substitute — §6.2 requires a tester working from the
executor's final SHA who does not trust the handoff. The `Review` column in
`completion-matrix.md` stays empty for this range until that review happens.

**Does not change:** nothing about D-01 through D-09. In particular no migration is
applied, no flag is enabled, no schedule is created, no secret is read, and no data
job is run by this branch.

---

## D-11 · 2026-08-06 · P11 adds two query parameters to the P10 inbox route

Plan §9's P11 lists only `apps/web/…` under **Primary files**. P11 as merged also
touches `funding-opportunity-inbox.service.ts` and
`funding-opportunities.controller.ts`, adding two optional query parameters —
`clientId` and `source` — plus a `clientId` / `source` / `countsAllClients` echo on
the response.

**Why:** two items in P11's own Work list cannot be built honestly without them.

- *"Preserve client deep links and enable a selected-client view."* The inbox is
  cursor-paginated. Narrowing to one client in the browser filters ONE PAGE of a
  keyset walk, so a page containing no rows for the chosen client renders as "this
  client has nothing" while more rows sit further down the walk. The narrowing has
  to be in the WHERE clause or it is wrong.
- *"Keep source type as a filter, not the top-level workflow model."* There was no
  source filter on the inbox to keep.

**How to apply:** when a phase's Work list requires a capability the phase's file
list does not include, add the capability and log it here. Do not implement the
requirement client-side where it produces a different answer than the server would.

**Security note:** `clientId` is intersected with the ethical-wall allow-list, never
trusted. An unknown or walled id is silently dropped and the response reports the
narrowing it actually applied — deliberately not a 404 or 403, either of which would
confirm that a client the reader may not see exists. `source` is the opposite: an
unknown value is a 400, because a mistyped source has no privacy dimension and
quietly returning grants to a caller that asked for contracts is worse than refusing.

---

## D-12 · 2026-08-06 · The inbox pays for its own freshness read

The inbox reads `client_funding_opportunity` snapshots, so a dead source rail does
not empty it — it serves last week's picture, which is the more dangerous failure.
Rather than add `freshness` to the inbox response (whose computation is three raw
queries including two full-table counts, on an endpoint whose whole design goal is
to stay cheap), the inbox view issues `GET /opportunities?pageSize=1` and reads only
`freshness` from it.

**Why:** this is the SAME request the page issued on every load before P11, just with
`pageSize=1` instead of `25`. Net request count per page view is unchanged, and the
default experience keeps the rail-health strip it would otherwise have lost.

**How to apply:** when a new default view needs a fact an old view got for free, check
whether the old request can be shrunk before widening a new one.

---

## D-13 · 2026-08-06 · P11 continues the single-branch model (D-10 extended)

P11 was executed and merged as its own branch and PR — closer to §6.1 than D-10's
P00–P10 range — but still with no §6.2 independent tester. Per explicit user
instruction, each phase merges on its executor's own evidence.

**Consequence, unchanged from D-10:** the `Review` column stays empty. Green CI plus
self-testing is not the §6.2 gate.

---

## D-14 · 2026-08-06 · The detail body is one component, rendered in two frames

P12 ships `FundingOpportunityDetail` (the body), `FundingOpportunityDrawer` (the
inbox frame) and `FundingOpportunityDetailPage` (the routed frame). Both frames
render the body unmodified. There is deliberately no `compact` prop, no
drawer-specific section subset and no second layout.

**Why:** two renderings of one record that can disagree is how somebody makes a
decision from the shorter one. Later phases add five sections to this surface; each
must land in both frames or in neither, and the only way to guarantee that without
discipline is to make it structurally impossible.

**How to apply:** later phases (P23 acquisition position, P28 timeline, P31
requirements, P32 assessment, P33 landscape) fill in existing sections in the body.
They must not add a section to a frame.

---

## D-15 · 2026-08-06 · "Not yet available" and "Not provided" are different sentences

Every empty thing on the detail surface says which kind of empty it is.

- **"Not yet available"** — Capiro does not build this yet. A product gap, and each
  one names what will fill it.
- **"Not provided"** — the source holds no value for this field. A source fact.

**Why:** collapsing them blames the wrong party, and both are worse than the third
option a blank cell produces — reading as a NEGATIVE. An empty requirements panel
that rendered nothing says "this solicitation has no requirements", which is never
true. An empty acquisition panel that rendered nothing says "no route to this
acquisition", which is a determination against a client made from an absence of
data. The acquisition section carries a test asserting it contains none of "cannot
bid", "not eligible" or "no access".

**How to apply:** a new section with no data picks one of the two sentences. Neither
is optional, and neither may be shortened to a dash.

---

## D-16 · 2026-08-06 · Opportunity identity is (source, sourceRecordId, clientId)

`encodeOpportunityRef` / `decodeOpportunityRef` are the only place a ref is built or
parsed, and every part is `encodeURIComponent`d before joining.

**Why three parts:** relevance, eligibility, the recommendation and the decision are
all facts about a client-opportunity PAIR. A two-part ref would silently render the
unscored catalog view.

**Why encoded:** Grants.gov opportunity numbers are free-form source strings. An
unencoded `:` or `/` in one splits the ref into the wrong pieces — a bug that shows
up on exactly the records that contain the character and on no others.

**Relationship to P13:** P13 introduces the same idea on the API side
(`sourceRecordKey` / `sourceRecordType`, with identity parsing centralised). These
must stay compatible; the web ref is the URL form, P13's key is the storage form.

---

## D-17 · 2026-08-06 · P13 widens the DATABASE source vocabulary, not the API's

The migration's `client_funding_opportunity_source_chk` now admits
`agency_forecast`, `dibbs` and `sbir_sttr` alongside the two legacy sources.
`OPPORTUNITY_SOURCES` in `funding-opportunities.types.ts` is unchanged, and that
is the list every DTO, filter and route validates against.

**Why widen at all, in a phase that enables no new source:** the generic branch of
the exclusivity CHECK — "a non-legacy source carries the generic pair and no legacy
pointer" — is unreachable if no non-legacy source is admissible. An unreachable
constraint is an untested one, and proving that branch holds is this phase's whole
job. It was proven by attempting the actual writes against pgvector:pg16.

**How to apply:** P24, P40 and P42 each enable their source by adding it to
`OPPORTUNITY_SOURCES` and shipping the producer that writes it. Neither needs
another migration to do so. A spec asserts today that no service, controller or
producer names any planned source.

---

## D-18 · 2026-08-06 · A CHECK that evaluates to NULL is a CHECK that PASSES

The first version of P13's exclusivity CHECK contained:

```sql
("source_record_key" IS NULL AND "source_record_type" IS NULL)
OR ("source_record_key" IS NOT NULL AND "source_record_type" = 'grants_gov_opportunity')
```

A row with a key and a NULL type takes `FALSE OR (TRUE AND NULL)` → `NULL`, and
Postgres admits a row whose CHECK is NULL. **The row inserted successfully in
rehearsal.** The fix is an explicit `"source_record_type" IS NOT NULL` before each
equality, which turns the branch FALSE.

**Why it matters beyond this constraint:** the all-or-nothing rule on the generic
pair is what stops a key that cannot be resolved to a table. Silently admitting a
half-identity would have surfaced later as an unresolvable row in whichever phase
first tried to join on `source_record_type`.

**How to apply:** any CHECK comparing a NULLABLE column with `=`, `<>` or `IN` must
either guard with `IS NOT NULL` or use `IS [NOT] DISTINCT FROM`. Reviewing the SQL
did not catch this; attempting the write did. Every CHECK branch in this program
gets a real INSERT against real Postgres, one per branch, pass and fail.

---

## D-19 · 2026-08-06 · The CI index-declaration glob was missing every migration after the first three

`.github/workflows/funding-opportunities-ci.yml` asserted that every index created
by "the funding migrations" is declared in `schema.prisma`, globbing
`*_funding_opportunities*/migration.sql`.

The original three migrations are named `..._funding_opportunities*`. P07 is
`20260819010000_funding_opportunity_decisions` and P13 is
`20260820010000_funding_opportunity_generic_source` — **singular**. Neither matched,
so the check had silently stopped covering new migrations: exactly the quiet
shrink it exists to prevent. Widened to `*_funding_opportunit*`, which now covers
14 indexes across all five migrations; all 14 are declared.

**How to apply:** a gate that globs on a naming convention needs a test that the
glob still matches something it is supposed to. This one had `if [ -z "$names" ]`,
which only catches matching NOTHING — not matching a shrinking subset.

---

## D-20 · 2026-08-06 · The Tango SDK is real, and its models are thinner than the plan assumed

The plan names `@makegov/tango-node` without specifying a version. The package
exists on npm at `1.1.0` and was pinned exactly (no `^`/`~`).

Two things the SDK's real schemas contradict about the plan's field list, both
discovered by driving the actual SDK against a fake transport rather than by
inspecting its `.d.ts` files by hand:

- **Opportunities carry no notice TYPE and no single posted date.** The provider
  models notice type and posting date on individual NOTICES; an opportunity has
  `first_notice_date` / `last_notice_date` only. `TangoOpportunity` reflects this —
  there is no `noticeType` field, and no synthetic one was invented.
- **Forecasts carry no anticipated solicitation date, no PSC, and no estimated
  value.** `TangoForecast` has an `estimatedPeriod` (free text, e.g. "Q3 FY27")
  instead of a parseable date, and no money field at all. P24, which builds on
  this type, cannot promise a forecast dollar figure — that is a fact about the
  provider, not a gap in this adapter.

**Why this was caught here and not later:** `tango.client.spec.ts` runs the real
SDK through a fake `fetchImpl`, so the SDK's own `explicitSchemas` validation
executes in CI. The first draft of `tango.shapes.ts` invented plausible-sounding
field names (`legal_business_name` was right; `registration_expiration_date`,
`total_awards_obligated`, `notice_type` on an opportunity were not) and every one
was rejected by the SDK before a request was even issued — `ShapeValidationError:
Field "X" does not exist on model "Y"`. A mocked SDK would not have caught this;
the mock would have agreed with whatever the mapper assumed.

**How to apply:** when a phase's field list came from the PLAN rather than from
the vendor's own schema, verify it against the vendor before writing the mapper.
For this SDK specifically, the source of truth is
`node_modules/@makegov/tango-node/dist/shapes/explicitSchemas.js` — a generated
file with the real field name, type, and nesting for every model, not a `.d.ts`
comment or the plan's own description.

---

## D-21 · 2026-08-06 · The SDK is ESM-only; apps/api is CommonJS

`@makegov/tango-node@1.1.0` declares `"type": "module"` and ships no CommonJS
build. `apps/api` compiles to CJS. TypeScript refuses a static `import` of an ESM
package from a CJS file outright (TS1479), and its own error message says to use
a dynamic `import()` instead — which is what `tango.client.ts` does.

That created a SECOND problem: a bare type-only `typeof import('@makegov/tango-node')`
also failed to build under TS 5.9 (TS1542), because a type-only import of an ESM
module from a CJS file needs an explicit `resolution-mode` import attribute. Fixed
with `typeof import('@makegov/tango-node', { with: { 'resolution-mode': 'import' } })`.

A THIRD problem, orthogonal to both: jest's own CommonJS module registry cannot
`require()` an ESM package, even though Node 22 can. A static import died at
collection ("Unexpected token 'export'"); `new Function('return import(s)')` was
still intercepted by jest's VM and demanded `--experimental-vm-modules`;
`createRequire(__filename)` still landed in jest's patched compiler. What actually
works is transforming the ONE package back to CJS for tests — `jest.config.cjs`
gained a second `transform` entry plus a `transformIgnorePatterns` carve-out
scoped to `@makegov`, so no other package in `node_modules` is touched.

**Net effect for the adapter:** `tango.client.ts` loads the SDK through a memoised
dynamic `import()`, which is also why the SDK module is never parsed for a
deployment with no key — a side benefit of the same design, not the reason for it.

**How to apply:** the carve-out is scoped to `@makegov` on purpose. If another
ESM-only dependency needs the same treatment, widen the `transformIgnorePatterns`
regex deliberately — do not switch it to transform all of `node_modules`, which
would slow every suite in `apps/api` for every future test run.

---

## D-22 · 2026-08-06 · The versioned-head policy for tango_resource_snapshot

Plan §P15 asks for "duplicate same-hash snapshot is a no-op; changed content
creates a new observation/version or updates a versioned head according to the
documented policy" — leaving the exact policy to the implementer. Documented
here since nothing else in the plan specifies it.

**The policy:** `tango_resource_snapshot` is APPEND-ONLY. A given row's content
columns (`contentSha256`, `normalizedJsonb`, `sourceUpdatedAt`,
`providerFetchedAt`) never change after INSERT. At most one row per
`(resourceType, externalId)` carries `active = true` — the current head — enforced
by a partial unique index, not just application discipline. When new content
differs from the current head, the old head is flipped to `active = false` with
`supersededAt` stamped, and the new content is inserted as a new row, versioned
one past it. An EXACT repeat of already-stored content (same `contentSha256` for
that resource) is a true no-op: no row is touched, not even a timestamp.

**Why append-only rather than update-in-place:** the plan's own acceptance
criteria ask for "immutable observation hashes," and an update-in-place head
would mean the row's hash is only ever true of whatever the LATEST write left
behind — there would be no way to answer "what did we observe on this resource
in March" six months later. Append-only costs one column (`version`) and one
partial index; it buys the full history for free.

**Why the natural-key check happens BEFORE touching the current head:** an exact
repeat must supersede nothing — if duplicate suppression ran after the
supersession step, a nightly re-sync of completely unchanged data would flip the
active row to inactive and immediately back to active, doubling write volume for
zero informational gain and creating a churn of `supersededAt` timestamps that
lie about when anything actually changed.

**How to apply:** P19/P22/P24/P27, the phases that will actually call
`writeSnapshot`, do not need to reason about this policy themselves — call the
method and trust the invariant. A phase that needs "what changed since I last
looked" reads `getSnapshotHistory` and diffs against its own last-seen version,
never by comparing `updatedAt` (there is no such column, on purpose).

---

## D-23 · 2026-08-06 · proposeLink vs reviewLink: durability protects against automation, not correction

`tango_resource_link` has two write paths with a deliberately different
durability rule, both proven by tests:

- `proposeLink` (called by AUTOMATED crosswalk code, e.g. P27) is idempotent and
  **never resurrects a rejected link** — re-proposing the same pair after a human
  rejected it returns the rejected row unchanged.
- `reviewLink` (an EXPLICIT human action) **may** move a rejected link back to
  active, stamping a fresh actor and timestamp every time it is called.

**Why the asymmetry, rather than making rejection permanently final everywhere:**
plan §4.6 requires "rejected mappings and enrichment proposals remain durably
rejected," and the risk that invariant guards against is a NIGHTLY JOB silently
undoing a human's considered decision by re-proposing the same candidate. It does
not — and should not — mean a human can never correct a mistaken rejection
through a deliberate, audited action of their own. Making rejection truly
permanent would mean the only fix for a wrong rejection is a second row for the
same pair, which the natural-key uniqueness on `(local_resource_type,
local_resource_id, tango_resource_type, tango_external_id)` explicitly forbids.

**How to apply:** any later phase adding a THIRD write path to this table must
decide which category it falls into — automated proposal (never resurrects) or
human review (may transition freely) — and there is no third option that is
"a little bit of both."

---

## D-24 · 2026-08-06 · D-19's CI gap re-checked, and re-found, on this migration's own name

D-19 (P13) widened the "every index a migration creates is declared in
schema.prisma" glob from `*_funding_opportunities*` to `*_funding_opportunit*`
after discovering P07 and P13's own migration directories didn't match the
original pattern.

This migration's directory, `20260821010000_tango_source_substrate`, matches
NEITHER glob — it contains neither `funding_opportunit` nor, at the time D-19 was
written, any pattern for `tango`. Checked deliberately before merging (the
lesson from D-19 was "a gate that globs on a naming convention needs a test that
the glob still matches something," which prompted actually re-running the check
against this migration's name rather than assuming the P13 fix generalized), and
found to need a second glob: `apps/api/prisma/migrations/*_tango_*/migration.sql`.

**How to apply:** every phase that adds a new migration directory outside the
`_funding_opportunit*` naming family (P19, P22, P24, P27, and beyond — anything
prefixed `_tango_*` is covered now, but a differently-named future migration is
not) must re-verify this glob actually matches its directory before considering
the phase's CI wiring complete. "It worked for the last phase" is not evidence
that it works for this one.

---

## D-25 · 2026-08-06 · infra/cdk had zero tests; P16 could not honestly skip writing them

The plan's P16 acceptance criteria require "CDK synth tests prove the key is
absent from serve/migrate containers and present only in sync when
configured." `infra/cdk` had no test runner, no `test` script, and no
`test/` directory at all before this phase.

**Why a source-level check (grep the .ts file for `TANGO_API_KEY`) was not
enough:** it can only prove what the SOURCE says, not what the SYNTHESIZED
CLOUDFORMATION TEMPLATE contains. A bug where some other code path — a shared
secrets spread, a stray assignment — put the key on the serve task's Secrets
array despite the source appearing correct would pass a grep and fail a synth
assertion. Only `Template.fromStack` settles the question the acceptance
criterion actually asks.

**What was added:** `jest` + `ts-jest` as devDependencies, a minimal
`jest.config.cjs`, and `infra/cdk/test/compute-stack.tango.spec.ts` — a REAL
synth against a minimal-but-real dependency graph (a tiny unprovisioned VPC
via `new ec2.Vpc()`, not `ec2.Vpc.fromLookup`, which would require live AWS
API access and make the test flaky/impossible in CI). The suite proves:
absence when unconfigured, presence on the sync-jobs task ONLY when
configured, the exact secret name/ARN shape, no bare secret value anywhere in
the template, and — as a check on the harness itself — that it can still
reproduce the PRE-EXISTING LEGISTORM_API_KEY/CENSUS_API_KEY placement rule.
That last test exists because a harness that cannot verify a known,
already-shipped invariant is not trustworthy for a new one either.

**Not a full ComputeStack regression suite.** `ComputeStack` has ~15 task
definitions and dozens of env vars; asserting all of them is future work this
phase does not claim to have done. Scoped deliberately to what P16 changed.

**How to apply:** `pnpm --filter @capiro/infra-cdk test` is wired into
`ci-pr.yml` (DB-free, AWS-free, so it belongs in the generic gate, not the
Postgres-provisioning funding-opportunities-ci.yml). Any later phase adding
another CDK-visible secret or task-definition change should extend this test
file or add a sibling, not skip testing it because "there wasn't one before."

---

## D-26 · 2026-08-06 · The real secret ARN is now in infra/cdk/lib/config.ts

Per the AWS info supplied for this session: a secret named `tango` (not
`capiro/dev/tango-api-key`, the plan's suggested naming — this is the
secret's actual, already-created name) exists in account `967807252336`,
region `us-east-1`, at
`arn:aws:secretsmanager:us-east-1:967807252336:secret:tango-c0YGNk`.

`config.ts`'s dev `externalSecretArns.tangoApiKey` now holds this real ARN,
matching every other entry in that block (each one is a real, live ARN, not a
placeholder). This is the literal fulfillment of the plan's own P16
instruction — "Do not add the secret ARN to the live task configuration
until P16 code is merged and the secret exists" — not a departure from it:
the secret exists now, and this commit is the P16 merge.

**What this does NOT do:** wiring the ARN into CDK source changes nothing
live. `cdk deploy` was not run. The ARN only takes effect on Compute stack's
NEXT deployment, and per the plan's own Ship note for P16, live
task-definition wiring is deferred until P17 is ready to actually use the
key — a later, deliberate, separate action.

**Security note:** only the ARN was handled, never the secret VALUE. No tool
call in this phase read the secret's contents (`GetSecretValue` was never
invoked); the CDK `Secret.fromSecretsManager` construct only ever needs to
know that the secret exists, not what it holds.

---

## D-27 · 2026-08-07 · A second reviewed file inside the SDK boundary, and a three-way "why is `call` null" split

P17 needs to probe roughly 30 SDK methods to check capability/tier across
every dataset P19–P47 might depend on. `TangoGateway` (`tango.client.ts`,
P14) is deliberately narrow — 8 methods, exactly what product code calls.
Widening it to every rarely-used diagnostic method would pollute the
contract product code actually relies on, so `tango-capability-probe
.service.ts` is a SECOND file, still inside `external/tango/` (the boundary
that matters — no code outside this directory may ever import the SDK).
`tango.client.spec.ts`'s import-boundary test now names both files
explicitly rather than asserting exactly one; the invariant it protects is
unchanged.

Several probes have no SDK method to call at all (`exclusions`, `dibbs`,
`sbir_sttr`, `mcp_key_header_compatibility`, `webhook_write_apis`), and two
more (`entities`, `vehicle_awardees`, `vehicle_orders`,
`budget_flows_by_entity`) need a real UEI/vehicle-uuid this run may not have
been given. Both end up with `call: null` — but they are not the same fact,
and collapsing them into one `unsupported` status would actively mislead:

- **`unsupported_by_provider`** → reports `unsupported`. A genuine SDK gap —
  no DIBBS/SBIR-STTR method exists, no dedicated exclusions endpoint, MCP is
  an unwrapped separate connector. A fact about the provider/SDK surface.
- **`no_identifier_supplied`** → reports `not_attempted`. A fact about how
  THIS run was invoked, not the provider. An invented UEI would only prove
  the 404 path — pass a real one to actually exercise these probes.
- **`mutating_write_excluded`** → also reports `not_attempted`, but for a
  different reason than the one above: the SDK **demonstrably has**
  `createWebhookEndpoint` et al. — this is not a provider gap at all. This
  probe's own read-only policy forbids calling a mutating method, ever
  (see the class doc's "what this must never do" list). Reporting this as
  `unsupported` would tell a reader the provider cannot do webhook writes,
  when the true, narrower fact is that this diagnostic chose not to try.

The first draft of this file collapsed all three into a single
`unsupported`/`call: null` branch with no `skippedReason` field at all —
caught and corrected before merging, not after; see D-28 for a second,
independent bug the same review pass found in the same file.

**What this forbids:** any future probe added to this file must set
`skippedReason` if `call` is null — there is no fourth, unlabeled reason to
fall back on, and the `run()` method has no default branch that guesses.

---

## D-28 · 2026-08-07 · A script's own test suite triggered a live API call, because `main()` ran on import

`diag-tango-capabilities.spec.ts` imports `parseArgs`/`formatSummary` from
`diag-tango-capabilities.ts` to test them without a real key or network
access. The script's first draft called `main().catch(...)` unconditionally
at module scope — exactly the line every other executable script in
`apps/api/scripts/` already guards against, via an `isDirectRun` check on
`process.argv[1]` (see `backfill-sam-opportunity-fields.ts`). Missing that
guard here meant every test run (and any future script importing this one's
exports for reuse) would silently attempt a real, live call against the
Tango API as a side effect of the `import` statement alone — in test, that
surfaced as a harmless "no API key" error on stderr; in an environment where
`TANGO_API_KEY` happens to be set, the same import would have fired for
real, unrequested and unlogged as a deliberate action.

Caught by actually reading the test run's console output rather than only
its pass/fail line — the suite was green throughout; the bug produced no
failing assertion, only an unexpected `console.error` line riding along with
a passing test.

Fixed by adding the same `isDirectRun` guard every sibling script already
uses, and exporting `main` explicitly (unused today, but the established
convention, and it costs nothing).

**What this forbids:** a new script under `apps/api/scripts/` that performs
a real side effect (network call, write, mutation) must gate its `main()`
invocation behind an `isDirectRun` check if it exports anything a spec file
might import — "it has tests" is not evidence the import itself is safe.

---

## D-29 · 2026-08-07 · The real account run found a genuine gap in the report's own status vocabulary

Per the plan's P17 acceptance criteria, the probe was run once against the
real Tango account (key fetched from Secrets Manager `tango`, ARN
`arn:aws:secretsmanager:us-east-1:967807252336:secret:tango-c0YGNk`,
piped directly into the subprocess environment in one command — the raw
value never appeared separately in this session's own visible output at any
point). Authentication succeeded; 14 of 24 probed capabilities are supported
outright. Full sanitized report:
`docs/plans/funding-opportunities-makegov-v1/p17-tango-capability-report.json`.

**The live run itself found a bug in `tango-capability-probe.service.ts`**,
not just in the Tango account's capabilities: `attachment_metadata` and
`extracted_text` (both calls into `searchOpportunityAttachments`) answered a
synthetic one-character query with a classified HTTP 404, and `run()`'s
error branch only ever distinguished `tier_gated` from a catch-all `error`
— every other `TangoErrorKind` (`auth` past the version preflight, `not_found`,
`validation`, `rate_limit`, `transient`, `permanent`) collapsed into the same
generic `error` status. `tango.errors.ts` already documents `not_found` as
"often meaningful evidence, not a failure" — a 404 from a SEARCH-shaped
endpoint is unusual (most REST search endpoints answer "nothing matched"
with 200 + an empty page, not 404), which makes it exactly the kind of fact
this phase exists to surface, not bury inside an undifferentiated `error`
bucket that reads identically to "this call is broken."

Added `not_found` as its own `ProbeStatus`. The probe was then re-run
against the real account a second time, against the corrected code, to
capture the report that is actually attached as evidence — the first run's
raw output was discarded rather than hand-edited, so the committed artifact
is real tool output, not a report doctored to match the code after the fact.

Other real findings from the run (all consistent with SDK-level findings
already recorded in D-14/D-20's method inventory, now confirmed against the
live account rather than only the SDK's static surface): `exclusions`,
`dibbs`, `sbir_sttr`, and `mcp_key_header_compatibility` are confirmed
genuinely unreachable through this SDK version — P39–P45 must not assume
otherwise. `webhook_write_apis` remains untested by policy; P46/47's
tier-documentation discrepancy is still open. `entities` and both vehicle
probes were `not_attempted` because this run supplied no `--uei`/
`--vehicle-uuid` — a follow-up run with a real identifier is needed before
P19–P23 can rely on those specific findings.

**What this forbids:** treating a `call: null` finding derived from static
SDK-surface reading (D-27) as equivalent to a LIVE finding derived from an
actual account response — both are real, but only the latter proves the
account's own tier/configuration, not just the SDK's method list. The report
schema keeps them as visibly different statuses for exactly this reason.

---

## D-30 · 2026-08-07 · P18 needs no migration — breaker state is in-memory, by architecture, not by omission

The completion-matrix placeholder for this phase said `Migration:
conditional`. The condition: does circuit-breaker/health STATE need to
survive a process restart? It does not, given how these calls actually run —
`ApiSyncJobsTaskDef` (P16) dispatches every sync job as its own ephemeral ECS
task, a fresh process per run. A breaker that opened during run N is
meaningless information for run N+1, which starts with a fresh process, a
fresh `TangoResilienceService` singleton, and correctly a fresh, closed
breaker — there is nothing to "restore." Persisting breaker state to Postgres
would solve a problem this architecture does not have, at the cost of a
migration, a table, and a real question ("how stale can a persisted breaker
state be before it is actively wrong") that the in-memory design never
raises.

What DOES need to survive a process — usage history, for the `diag-tango-
health` report — already has its table (`tango_api_usage`, P15). P18 adds no
schema at all; every new file is code only.

**What this forbids:** treating "per run" and "per process lifetime" as
requiring an explicit reset mechanism between them. They are the same fact
under this architecture; adding a reset method would be solving a problem
that reassigning-a-new-process already solves for free — and would invite a
future caller to reset the counter WITHOUT actually starting a new process,
which is the one thing that must never happen (a manually-reset ceiling on a
long-lived process is exactly the "unsupervised quota spend" the ceiling
exists to prevent).

---

## D-31 · 2026-08-07 · Two gateway tokens, not one changed in place

`TANGO_GATEWAY` (P14) already has a documented contract: 8 methods, no
retry, no ceiling — `tango.client.ts`'s own class doc says P18 owns that
layer. Two ways to add it: change what `TANGO_GATEWAY` resolves to (every
existing and future consumer gets retry/breaker/ceiling transparently,
whether it expects to or not), or add a second, separately-injected token
that WRAPS the first. This phase takes the second path:
`TANGO_RESILIENT_GATEWAY` → `TangoResilienceService`, implementing the same
`TangoGateway` interface, constructed from the raw `TANGO_GATEWAY` instance.

Reasoning: nothing yet consumes `TANGO_GATEWAY` in product code (P19 is the
first real consumer, not yet built), so there is no existing behavior to
preserve either way — but changing an already-documented, already-tested
token's MEANING out from under it, in a LATER phase, for a class the token's
own original phase explicitly deferred to that later phase, is the kind of
thing that reads fine in isolation and becomes surprising the next time
someone reads P14's decision log and P18's code and finds they now disagree
about what `TANGO_GATEWAY` means. Keeping both, documented side by side (see
tango-resilience.service.ts's class doc), costs one extra token and one
extra module registration, and means a future reader of either file finds an
explanation rather than a discrepancy.

**What this forbids:** P19 and later real-call phases injecting the raw
`TANGO_GATEWAY` token for ordinary product work. Both module doc comments
now say so explicitly. A future consumer with a genuine, specific reason to
want the unprotected gateway may still reach it — but that should be a
documented exception, not the default nobody decided.

---

## D-32 · 2026-08-07 · The breaker counts LOGICAL failures, not raw attempts — and a half-open failure reopens for a FULL cooldown

Two mechanics worth stating precisely, because both are easy to get subtly
wrong in a way that still passes a shallow test:

**Consecutive failures, not consecutive attempts.** A single logical call
retried twice before finally failing increments the breaker's counter by
ONE, not three — the counter is incremented once, after `MAX_ATTEMPTS` is
exhausted for that call, inside `registerFailure()`, never inside the retry
loop itself. Counting raw attempts would make the configured threshold (5,
by default) reachable by fewer than two genuinely-failed operations, which
is not what `config.schema.ts`'s own comment describes ("Consecutive
transient/rate-limit failures before the breaker opens").

**A failed half-open trial reopens for a full cooldown, not a partial one.**
Once the cooldown elapses, exactly one call is let through as a trial. If it
fails, the breaker does not require a fresh full threshold's worth of
failures to reopen — one bad sign during recovery is treated as sufficient,
and the cooldown restarts at its FULL configured duration from that moment,
not the remainder of some earlier window. `tango-resilience.service.spec.ts`
proves this exactly: a breaker that reopens at t=1000 (cooldown=1000) is
still refusing calls at t=1999 and lets the next trial through only at
t=2001 — a full second window from the reopen, not from the original open.

**What this forbids:** any future change to the retry loop that moves
`registerFailure()`'s call site inside the per-attempt catch block instead of
after retries are exhausted — that would silently change the threshold's
real-world meaning without changing its documented value.

---

## D-33 · 2026-08-07 · Two kinds of "health," and no live-key run for this phase

`TangoResilienceService.getHealth()` (in-memory, this process, right now)
and `TangoStoreService.getUsageHealth()` (persisted, any process, historical)
answer genuinely different questions — see tango-resilience.service.ts's
class doc. `diag-tango-health` exists because the SECOND question is the one
answerable from an operator's shell, which shares no memory with whatever
sync task ran an hour ago.

Unlike P17, this phase's own completion-matrix acceptance line does not ask
for a run against the real account — it asks for "Fake-clock retry/breaker
proof; a 400 attempted once," which `tango-resilience.service.spec.ts`
delivers deterministically and exhaustively (38 tests). A live run was
considered and deliberately not done: proving retry/breaker timing for real
would mean deliberately inducing a 429 or a string of failures against the
same real, rate-limited, purchased account P17 already exercised — spending
real quota to re-prove, non-deterministically, what the fake-clock suite
already proves exactly and repeatably. The pieces a live run WOULD newly
confirm — that `tango_api_usage` inserts succeed against real Postgres — are
already proven by P15's own migration rehearsal for that exact table, and
that DI wiring resolves with real config is already proven by
`tango.module.spec.ts`'s real (if bare) `Test.createTestingModule` harness.

**What this forbids:** treating the absence of a live-key run here as an
oversight matching P17's. It is a scoped, stated choice — a future phase
that wants a live proof of retry/breaker behavior specifically should say so
explicitly rather than assume this phase already attempted and failed to
get one.

---

## D-34 · 2026-08-07 · A client's Tango sync status lives on `clients` itself, not a link table

P19 needs to relate a client to the Tango Entity fetched for it. The obvious-
looking answer — a `tango_resource_link` row (P15) — is wrong on inspection:
`tango-store.service.ts`'s `assertKnownLocalType` explicitly refuses a
tenant-owned local resource type, and `clients` carries `tenant_id`. That
table exists to link a Tango resource into one of Capiro's own GLOBAL
reference tables (`federal_contractor` et al.), never to a tenant's row.

The actual answer needs no link at all: a UEI is already a global, exact,
1:1 government identifier, and `Client.uei` and
`tango_resource_snapshot.external_id` are the SAME value for the SAME
entity. `WHERE external_id = client.uei` IS the relationship — no join table
adds anything a plain equality doesn't already give for free.

What DOES belong on `Client` is the client's OWN sync bookkeeping — three
additive nullable columns (migration `20260822010000_client_tango_entity_sync_status`):
`tango_entity_last_synced_at` (last SUCCESSFUL sync — found or not_found are
both a definitive answer, not a failure), `tango_entity_last_attempt_at`
(every attempt, independently, so a repeatedly-failing sync cannot read as
healthy because it once succeeded), and `tango_entity_last_error` (redacted,
cleared on the next success). Same freshness-tracking shape this program
already documents elsewhere (`sourceFreshnessSemantics`).

**What this forbids:** a future phase reaching for `TangoResourceLink` to
connect a Tango resource to ANY tenant-owned row. If the local side is
tenant-owned, the relationship belongs on that row directly (as here) or on
a new tenant-scoped table with its own RLS — never on the global link table,
regardless of how convenient reusing it looks.

---

## D-35 · 2026-08-07 · A real SDK-vs-server field-name incompatibility, found live and fully diagnosed

The P19 live-key run (real account, rehearsal database — see D-36) hit a 400
on the very first real `getEntity` call: `"Invalid request parameters:
Invalid shape"`. This was chased to a full, precise diagnosis, not left as
"the account rejected something":

1. **The live server rejects this SDK's own field names.** A raw debug call
   against the real API confirmed `entity_structure_desc` and
   `state_of_incorporation_code` (P14's original `ENTITY_FIELDS`, taken
   faithfully from `@makegov/tango-node@1.1.0`'s bundled
   `shapes/explicitSchemas.js`) are `unknown_field` server-side. The
   server's own error payload includes its CURRENT `available_fields` list,
   which has bare `entity_structure`/`state_of_incorporation` instead — no
   `_code`/`_desc` suffix.
2. **Renaming to match the live server broke the other direction.** Passing
   the corrected bare names through the real SDK, via `tango.client.spec.ts`
   driven by a fake `fetchImpl` (no network — the SAME harness every other
   adapter test uses), threw `ShapeValidationError: Field "entity_structure"
   does not exist on model "Entity"` — thrown by the SDK's OWN bundled
   `ModelFactory`/`SchemaRegistry` when materializing a response, which
   still only knows the old `_code`/`_desc` pair.
3. **This is not `listEntities`-only.** Reading the SDK's own `getEntity`
   source directly confirmed it calls `materializeOne` on every SUCCESSFUL
   response, exactly like `listEntities` calls `materializeList` — an
   initial test against the synthetic (never-found) test UEI looked clean
   only because a 404 never reaches the materialization step at all. A REAL
   found entity would hit the identical client-side crash.

Net: **neither naming convention round-trips end-to-end** (request → typed
result) through this SDK version, for either method that returns a typed
Entity. This is the SDK's bundled reference schema genuinely lagging the
live API's current one — an external version-drift fact, not a Capiro typo
to fix by picking a different string.

**Fix:** `ENTITY_FIELDS` drops both fields entirely — not renamed, removed.
`mapEntity` returns `entityStructure`/`stateOfIncorporation` as an explicit,
commented `null` rather than a lookup that would always resolve to nothing
useful. The domain type keeps both fields (a future SDK release may resolve
this); the mapper's comment says why they are always null today so a future
reader does not mistake it for a missed field and "fix" it back into a
crash. `tango.client.spec.ts` gained a dedicated regression test asserting
both stay null even though the fixture deliberately carries plausible
values for both (as noise the shape never asked for) — proving the drop,
not just asserting it once in a comment.

**What this forbids:** re-adding either `entity_structure_desc`/
`state_of_incorporation_code` OR bare `entity_structure`/
`state_of_incorporation` to `ENTITY_FIELDS` without first confirming — live,
against the real account, through `getEntity` specifically (not just a
shape-string check) — that a NEWER `@makegov/tango-node` release has
reconciled its bundled schema with the live API. Escalate to MakeGov before
assuming a version bump alone fixes it.

---

## D-36 · 2026-08-07 · Migration rehearsal AND a live-key pipeline proof, composed for the first time

P19 is the first phase needing both disciplines this program has used
separately since P07 (migration rehearsal: clean replay, ordered upgrade,
retry-as-no-op) and since P17 (a live call against the real account). Doing
both together, on the SAME isolated database, proved more than either would
alone:

- **Clean replay**: the full 231-migration history, including
  `20260822010000_client_tango_entity_sync_status`, applied cleanly to a
  verified-empty `pgvector:pg16` container.
- **Ordered upgrade**: a SEPARATE database taken through every migration
  EXCEPT the new one, seeded with a real tenant + two clients — one with a
  UEI, one without — then the new migration applied on top. Exactly one
  migration ran; the pre-existing rows kept their data with the three new
  columns landing NULL, not backfilled.
- **Retry-as-no-op**: the migration SQL re-run by hand against the clean-
  replay database — `NOTICE: column ... already exists, skipping` three
  times, zero errors, column count unchanged.
- **Live-key pipeline proof**: `sync-tango-entities.ts --commit`, run
  against that SAME seeded ordered-upgrade database with the real key from
  Secrets Manager (fetched and piped directly into the subprocess
  environment, never appearing separately in this session's own output).
  `processed: 1` — proving, empirically, against a REAL Prisma query (not a
  fake double), that the name-only seeded client was never touched at all
  while the UEI-having one was. This is the strongest form of this phase's
  own acceptance bar: not just "the fake test passes" but "the actual SQL
  this ships with does the right thing against a real, populated database."
  The run also surfaced D-35 — a genuine bug the fake-double unit tests
  could not have caught, because they never had a reason to assert against
  the SDK's own materialization step.

**What this forbids:** treating a fake-double-only test suite as sufficient
evidence for a phase that is BOTH the first real consumer of a prior
phase's schema (P15's checkpoint table) AND the first real caller of a
specific gateway method end-to-end (`getEntity`, through `getVersion`-only
in P17's probe). Where both are true at once, run the real pipeline against
a real, disposable database before calling the phase done — a passing unit
suite proves the LOGIC; it does not prove the REQUEST.

---

## D-37 · 2026-08-07 · A new tenant-scoped table, not a stretch of an existing one

P20 needs to relate a proposed profile CHANGE to a client. Two existing
tables were considered and rejected on inspection, not just on vibes:

- `tango_resource_link` (P15) is reserved for linking a Tango resource into
  Capiro's own GLOBAL reference tables — `assertKnownLocalType` explicitly
  refuses a tenant-owned local type, and `clients` carries `tenant_id`.
- `client_intel_mapping` (P05) answers "is this external entity the SAME
  LEGAL ENTITY as this client" — a different question from "should this
  FIELD on the client's own profile change to this value". Reusing it would
  mean overloading `externalId`/`externalName`/`matchBasis` — a mapping's
  own vocabulary — to mean something else entirely for a different kind of
  row, which is exactly the kind of stretch that reads fine today and
  confuses the next person who has to reason about what a row in that table
  can mean.

So: a new table, `client_profile_enrichment_candidate`, TENANT-scoped
(unlike every Tango-owned table before it) with its own RLS, its own
vocabulary (`field` is the CLIENT model's own field name, verbatim), and
its own durability rule — modeled on, but not sharing storage with, the
propose/review pattern P15 and P05 both already established.

**What this forbids:** reusing `tango_resource_link` for anything that
would need to name a tenant-owned row as its "local" side. If a future
Tango-sourced fact needs to attach to a tenant-owned record, it gets its own
table (as here) or its own columns on that record (as P19's sync-status
columns), never a bent read of the global link table's own local-type CHECK.

---

## D-38 · 2026-08-07 · Certifications: a curated exact-match vocabulary, not a classifier

A false certification claim (HUBZONE, 8(a), SDVOSB, WOSB, EDWOSB, VOSB) has
real compliance consequences — this is exactly why the phase's own
acceptance bar singles out "no accept-all for certifications" specifically,
not just as one example among equally-risky fields.

`TANGO_BUSINESS_TYPE_TO_CERTIFICATION` is therefore a short, hand-reviewed,
case-insensitive EXACT-match table from Tango business-type description
strings to Capiro's six-value durable certification vocabulary
(`set-aside.ts`). A Tango business type that does not exactly match an entry
is never proposed — not fuzzy-matched, not substring-matched, not inferred
from a partial phrase. Same "UEI-first, never fuzzy" discipline this program
already applies to identity matching (P02), now applied to certification
TEXT.

Writing the curated table surfaced a real, easy-to-get-wrong distinction in
federal-contracting terminology: SAM.gov's plain WOSB designation is
singular ("**Woman** Owned Small Business"), while the EDWOSB program's
official name is plural ("**Women**-Owned Small Business"). A first draft of
the map used the plural form for both, which would have silently failed to
match the far more common plain-WOSB phrasing. Caught by a test asserting a
concrete, realistic business-type string maps correctly — not by inspection
of the map alone. Both singular and plural are now curated for plain WOSB
specifically, since this program has not yet observed a real Tango response
to confirm which phrasing this specific provider actually uses.

Also load-bearing: an EXISTING certification is never proposed for REMOVAL
just because a Tango snapshot's `businessTypes` doesn't mention it.
Absence of evidence is not evidence of absence — Tango not listing a
certification is not proof the client lacks it, and this service only ever
proposes ADDITIONS, never removals, for every array field it manages (NAICS
and PSC codes included).

**What this forbids:** widening the certification matcher to substring or
fuzzy matching, ever, regardless of how tempting a "close enough" partial
match looks when a real Tango response uses slightly different punctuation
or wording than the curated list. Add the new exact phrase to the curated
map instead — deliberately, reviewed, one entry at a time.

---

## D-39 · 2026-08-07 · Migration rehearsal PLUS a real (non-fake) service run, against real RLS

Same composed discipline D-36 established for P19, extended one step
further: after the usual clean replay / ordered upgrade / retry-as-no-op,
every CHECK constraint, the unique durability index, and both foreign keys
were proven by ACTUAL INSERT against the rehearsal database (8 cases: an
invalid `field`, a pending row wrongly carrying a reviewer, an accepted row
missing one, a valid pending row, a valid accepted row, a true duplicate
proposal refused, a same-hash-different-field row correctly accepted, and a
bogus client id refused by the FK) — not just read back out of the SQL file.

Then, uniquely for this phase: the REAL `ClientProfileEnrichmentService`
(not a fake double) was run directly against that same RLS-enabled,
FORCE-enabled database — propose, list, accept one candidate, reject
another, re-propose to prove durability, and a final read of the client row
confirming the accepted field changed and the rejected one did not. This
matters specifically because P20 is the first phase whose OWN correctness
depends on `PrismaService.withTenant`'s real tenant-scoping query-extension
actually working — every fake-double unit test necessarily bypasses that
mechanism entirely (the fake `withTenant` is `(id, fn) => fn(tx)`, no
scoping at all), so it is the one thing the unit suite structurally cannot
prove about this service.

**What this forbids:** treating `withTenant`/`withSystem` fakes in a unit
suite as proof that tenant isolation holds for a NEW service using them for
the first time. A fake that unconditionally calls through proves the
business logic; it actively cannot prove the isolation, because the fake's
whole job is to skip the part that would.

---

## D-40 · 2026-08-07 · A pure read aggregation, and why "versioned" means the FLAG, not array position

P21 needed no migration and no new persistence — it assembles three things
that already exist (first-party `clients` fields, P19's active Tango
snapshot, P15's full snapshot version history, P20's open review
candidates) into one view. This is `TangoStoreService.getSnapshotHistory`'s
FIRST real caller — written at P15, unused until now, exactly as that
phase's own doc predicted.

One detail worth recording because it is easy to get wrong invisibly:
`verified` (the currently-authoritative Tango observation) is derived by
finding the row in `history` whose `active` flag is true — NOT by assuming
it is the last element of the array. `getSnapshotHistory` orders by
`version ASC`, so in the overwhelmingly common case the active row IS the
last one, which means a version-position shortcut would pass every casual
manual check and still be wrong the one time a supersession is written out
of the version order an implementation assumes. `federal-business-profile
.service.spec.ts` proves this with a deliberately out-of-order fixture
(version 1 active, version 2 superseded) specifically so the test would
fail if a future edit ever "simplified" this to `history.at(-1)`.

`firstParty` and `verified` are returned as separate top-level sections,
never merged into one flattened object — restating, for a READ view this
time, the same "first-party authoritative, Tango verifies/enriches, never
silently overwrites" precedence P20 already enforces on the WRITE side. A
test asserts the two can disagree in the response without one clobbering
the other.

**No migration rehearsal for this phase** — there is nothing new to
rehearse. `PrismaService.withTenant`'s real tenant-scoping mechanism was
already proven end-to-end against real RLS in P20 (D-39); this service
uses the identical, already-proven code path for a read instead of a write,
so re-proving the mechanism itself here would be repeating evidence rather
than adding new coverage. The NEW thing this phase adds — the aggregation
and the active-flag-not-array-position rule — is exactly what the fake-
backed unit suite is suited to prove.

**What this forbids:** any future change to `getProfile` that computes
`verified` via `history[history.length - 1]` or `.at(-1)` instead of
`.find((v) => v.active)`. The two happen to agree today; they are not the
same question, and only one of them is the one this phase's name
("Versioned") is actually about.

---

## D-41 · 2026-08-07 · Vehicle-awardee parent UEI: a real provider data gap, not a naming mismatch

P22's live-key run failed `listVehicleAwardees` for all 5 vehicles tested,
identically: `{"path":"recipient.parent_uei","reason":"unknown_field"}`. This
looked, at first glance, like the same shape of problem D-35 already solved
(a naming mismatch between the SDK's bundled schema and the live server) —
it is not, and confirming that required going further than a rename.

A direct debug script forced the same error deliberately, to read the
server's own `available_fields` payload for this endpoint's `recipient`
expansion in full, rather than guessing at an alternate name. It lists
EXACTLY five fields: `cage`, `cage_code`, `display_name`,
`legal_business_name`, `uei`. No parent or owner UEI exists under any name
on this expansion. This is a genuine DATA limitation, not a naming one — no
string this adapter could request would produce it, because the server does
not carry it here.

Parent/owner data is not absent from Tango's model entirely — D-35's own
investigation already found `immediate_owner`/`highest_owner` on `getEntity`
— but reaching it for every awardee found on a vehicle would mean one EXTRA
`getEntity` call per unique awardee UEI: a materially more expensive design
than "list this vehicle's awardees", and a scope decision this phase
deliberately does not make under time pressure.

**Fix:** `parent_uei` removed from `VEHICLE_AWARDEE_FIELDS`.
`mapVehicleAwardee` hardcodes `recipientParentUei: null`.
`TangoVehicleAwardee.recipientParentUei`'s doc comment records that it is
always null as of this SDK/live-API version and why. The `relationship ===
'parent'` branch in `sync-tango-vehicles.ts` stays — tested, not deleted —
because the LOGIC is correct and the gap is the provider's current data
model, not this sync's design; deleting it would silently lose "you are on
this vehicle" vs. "your parent is" the moment the provider (or a future SDK
reaching `getEntity`'s owner expansions per-awardee) adds the data back.
Re-running the live sync after the fix confirmed `errored: 0` across all 10
vehicles tested, proving the fix — not just the theory — resolved the actual
integration.

**What this forbids:** re-adding `parent_uei` (or any other name) to
`VEHICLE_AWARDEE_FIELDS` without first re-confirming, live, that the
server's `available_fields` list for this specific expansion has changed.
Reaching parent/owner data for awardees via a per-UEI `getEntity` call is a
real, available design — but a deliberate, separately-scoped one, not a
silent addition to this sync's request-per-vehicle cost.

---

## D-42 · 2026-08-07 · Every list endpoint is page-number pagination; the SDK's own `.cursor` is unconditionally null for all of them

Re-verifying P22's D-41 fix live (`--limit=10`, dry run) surfaced a second,
larger problem: the summary reported `completeness: 'complete'` despite the
server's own `count` field reading 20,709 vehicles. Only 10 had been seen.

A raw debug script (bypassing `materializeList`, reading `client.http.get`'s
response directly) showed why: `/api/vehicles/`'s `next` field is
`"https://tango.makegov.com/api/vehicles/?limit=3&page=2"` — Django REST
Framework PAGE-NUMBER pagination, never `?cursor=...`. Calling `page=1` and
`page=2` explicitly confirmed the parameter genuinely works — the two calls
returned different vehicles. The SDK's own bundled
`buildPaginatedResponse`, read directly in `client.js`, computes its
`.cursor` field by parsing a `cursor` QUERY PARAMETER out of `next`
(`extractCursorFromUrl`) — which this `next` URL never has. Confirmed a
third way, independent of both the live call and the JS source: the SDK's
own `types.d.ts` documents `PaginatedResponse.cursor` as "`null` when the
endpoint is page-based" — its authors already knew this distinction exists.
Every one of the six list methods this gateway calls (`listEntities`,
`listOpportunities`, `listNotices`, `listForecasts`, `listVehicles`,
`listVehicleAwardees`) extends `ListOptionsBase` (`page?: number`, no
`cursor` field at all) — all six are the page-based case, unconditionally.
Only `/api/contracts/` (a method this gateway does not call) is documented
by the SDK as the cursor-based exception.

Net: `tango.client.ts`'s `page()` helper had been reading
`response.cursor ?? null` since P14 and getting `null` back from every one
of these six endpoints on every call, independent of whether more data
remained. `TangoPage.nextCursor`'s own doc — "OPAQUE... null means this is
the last page" — was therefore false every time it returned null after page
one. Checked whether this reached already-merged phases: P17's capability
probe never reads `nextCursor` (confirmed by grep — a one-shot-per-resource
probe has no reason to). P19's entity sync paginates over Capiro's OWN
`client` table via a genuine Prisma keyset cursor (`cursor: { id }, skip:
1`) and calls single-record `getEntity` per row — it never calls
`listEntities` at all, so it never touched this path. Only P22 (its own
`listVehicles`/`listVehicleAwardees` walks) is actually affected among
current work; P24's forecast sync would have hit the identical wall.

**Fix, entirely inside `tango.client.ts`'s shared `page()` helper — no
changes needed to any of the six call sites, or to any consumer.**
Capiro's own cursor stays exactly as opaque to every caller as its doc
already promised; `page()` is now the one place allowed to know what's
inside it. `parsePageCursor` decodes it back into a 1-based page number
(garbage or absent both mean page 1), sent to the SDK as `{ page, limit }`
instead of a stray, silently-ignored `{ cursor }`. `nextCursor` is derived
from the raw `next` field's presence — non-null means another page exists,
regardless of what the SDK's own `.cursor` says — encoded back out as
`String(page + 1)`. `entity-page.json`'s fixture (previously hand-authored
with an invented `?cursor=...` URL that no live response actually produces)
now carries a realistic `?page=2` `next` URL and a `cursor: null` matching
what the real SDK computes for it. `tango.client.spec.ts` gained tests
proving the page number round-trips through the query string, that a
missing/blank/garbage cursor all mean page 1, and that `nextCursor` is null
exactly when the provider's `next` is null — not when the SDK's `.cursor`
happens to be.

**What this forbids:** trusting the SDK's `PaginatedResponse.cursor` field
anywhere in this codebase without first checking, for that SPECIFIC
endpoint, whether its own doc comment's "page-based" carve-out applies —
and re-adding any direct `cursor` pass-through to a `c.list*()` call without
routing it through `parsePageCursor` first.

---

## D-43 · 2026-08-07 · A page fetched larger than what --limit leaves room for hid a resumability bug

While first building P22's vehicle walk, `--limit=2` against a single staged
page of 3 vehicles left `vehiclesProcessed` correct (2) but `completeness`
wrong (`'complete'`, when a 3rd vehicle plainly still existed). The cause:
`listVehicles` was requested with a flat `vehicleBatchSize` (default 25)
regardless of how much of `options.limit` remained. When the limit landed
mid-page, the inner loop's `break outer` — needed to stop enumerating a page
that came back bigger than what this run should consume — jumped past
`cursor = page.nextCursor` and the checkpoint write immediately below it.
`cursor` was left at its pre-page value (`null`, on a first-page stop), so
the final `ceilingReached || cursor != null ? 'in_progress' : 'complete'`
computed the wrong half of that ternary. A resumed run would have restarted
from scratch, silently re-walking vehicles already seen rather than
continuing — the entire point of a checkpoint, defeated by the one case
that most needs it (a run deliberately capped short of the full walk).

The existing test that exercised this exact scenario
(`vehiclesProcessed respects the limit, even mid-page`) had not caught it
because its fake `listVehicles` ignored the `limit` argument entirely and
always returned the full staged page — a fidelity gap in the fake, since a
real gateway (confirmed by D-42's own investigation into `clampLimit`/
`ListOptionsBase.limit`) never returns more than asked.

**Fix:** the outer loop now requests `Math.min(vehicleBatchSize, remaining)`
— never more than what this run could still consume — exactly the
discipline `sync-tango-entities.ts` already established in P19
(`Math.min(batchSize, remaining)`). With the page itself capped, the inner
loop can no longer need a mid-page `break outer` for the limit case at all;
that branch now exists only for `TangoRequestCeilingExceededError`, a
genuinely different, provider-forced early exit. The test fake was
corrected to truncate-and-synthesize-a-cursor when asked for fewer items
than staged — matching a real gateway's behavior — and the regression test
now asserts `completeness`, the actual persisted checkpoint's cursor, and
the exact `limit` sent to the gateway, not just the processed count.

**What this forbids:** any paginated walk in this codebase requesting a
"full" page size independent of how much of an overall `--limit` remains,
and any test fake for a paginated gateway method that silently ignores the
`limit` it was called with.

---

## D-44 · 2026-08-07 · Acquisition position is a CLIENT posture, not an opportunity crosswalk — and why the recommendation hook has no live trigger yet

P23's plan names six states, including `vehicle_not_identified` as distinct
from `no_direct_access_evidence`, and asks for a recommendation-engine
override "when vehicle access is required but unresolved." Both phrases
read, on first pass, as if this phase should determine which SPECIFIC
contract vehicle a SPECIFIC SAM/Grants.gov opportunity requires. It does
not, and this entry records why, because the alternative reading would have
produced a fabrication.

**No structured signal for "this opportunity requires a vehicle" exists.**
`FundingOpportunity` was checked field by field: `setAside`/`setAsideCode`
carry socio-economic set-aside categories (8(a), HUBZone, SDVOSB, WOSB),
never a vehicle restriction. `fundingInstrument` is populated for
`grants_gov` rows only — always `null` for `sam_gov`, confirmed by reading
`shapeUnscored`'s own SAM branch directly. No field anywhere carries a
vehicle name, IDV number, or "task order under X" fact. The only way to
infer one would be matching free text in the notice's title or description
against a known vehicle name — exactly the fuzzy-text-matching-as-identity
this program's own award-history rules (P02) forbid, restated here for a
different kind of identity claim. This phase's own plan lists no new
Prisma model or migration, confirming no crosswalk was ever in scope here —
that is P27+ territory ("Tango↔SAM crosswalk and parity ledger"), if it is
ever built at all.

**So acquisition position is computed once PER CLIENT, from P22's
`client_relevant_vehicle` data alone, and attached identically to every
`sam_gov` opportunity for that client** — the same shape of design P21's
`FederalBusinessProfile` already uses for provider-verified context. The
six states resolve from that CLIENT-level evidence:

  - `direct_prime_access` / `related_entity_access` / `known_teaming_route`
    — the best (self beats parent beats teaming) NON-EXPIRED relationship
    found. Expiry is read from the vehicle's own `lastDateToOrder`, joined
    from its full Tango snapshot (P15's `tango_resource_snapshot`) rather
    than added as a new column — P22's own materialized summary table
    never captured that field, and the full snapshot already holds it.
  - `no_direct_access_evidence` — the sync ran and found relevant vehicles,
    but every one is expired.
  - `vehicle_not_identified` — the sync ran and found ZERO relevant
    vehicles for this client at all.
  - `unknown` — Tango is not configured, or the vehicle sync
    (`sync-tango-vehicles`, P22) has never completed a run — read from
    P15's `tango_sync_checkpoint`, the same table `sync-tango-vehicles.ts`
    itself writes to.

`vehicle_not_identified` and `no_direct_access_evidence` stay genuinely
separate states — "found nothing at all" and "found vehicles but none
current" are different fact patterns a capture strategist would act on
differently — even though neither is opportunity-specific. Grants never
get a position at all (`acquisitionPosition: null`): a grant carries no
contract-vehicle concept, a source fact rather than a product gap.

**`known_teaming_route` is real, tested, and has no producer.** P22's
`client_relevant_vehicle.relationship` column is CHECK-constrained to
`'self'`/`'parent'` only — nothing anywhere writes `'teaming'`. The state
stays in `computeAcquisitionPosition`'s vocabulary and truth table (the
function accepts a `'teaming'` relationship and scores it correctly) so a
future teaming-partner data source — a formal partner/JV registry Capiro
does not have today — is a producer to add, not a scoring-function change.
Same shape of fact as D-41's dormant 'parent' relationship.

**The recommendation-engine override is real, tested, and has no live
trigger either — for the same underlying reason.** `vehicleAccessRequired`
would need to answer "does THIS opportunity specifically require vehicle
access", which is exactly the crosswalk that does not exist. Rather than
leave the acceptance criterion ("recommendation can move from pursue to
needs-review when vehicle access is required but unresolved") unbuilt,
`opportunity-recommendation.ts` gained the real, fully-tested override —
checked only after the existing 8 rules produce `pursue`, downgrading that
one outcome when `vehicleAccessRequired && !vehicleAccessResolved` — as a
POST-PROCESSING step, not a ninth numbered rule, so the original 8 rules'
carefully-ordered precedence is untouched. Both fields are optional; no
real caller sets either today, proven directly (`recommendOpportunity`
called with both fields omitted is byte-for-byte identical to the pre-P23
result — a dedicated test asserts this, not just describes it).

**Fix/build, concretely:** `acquisition-position.ts`'s
`computeAcquisitionPosition` is the pure, DB-free truth table
(`acquisition-position.spec.ts`, 18 tests: prime, affiliate, partner,
expired vehicle, multiple vehicles winning by rank not array order, and
both flavors of missing provider data). `AcquisitionPositionService` adapts
real `PrismaService`/`TangoStoreService` reads into that function's input
shape — constructed directly inside `FundingOpportunitiesService`, not a
separate DI-registered provider, matching how `recommendOpportunity` itself
is a plain function services call rather than an injectable service.
`funding-opportunities.service.ts`'s own new tests (+6) prove the WIRING
specifically — the one risk `acquisition-position.spec.ts`'s fakes cannot
catch, such as a wrong Prisma model or field name. Gated by a NEW flag,
`funding_opportunities_vehicle_fit`, read as a plain boolean
(`isFundingOpportunitiesFeatureEnabled`, factored out of
`FundingOpportunitiesFlagGuard` so a route guard and a data-shape check
share one fail-closed SQL query and can never disagree about what
"enabled" means) rather than a route guard — the field lives inside an
already-flagged response, so "off" must mean "respond exactly like P22"
plus one null-valued key, never a 404.

**What this forbids:** inferring a required vehicle from an opportunity's
title, description, or any other free-text field — that is a fuzzy-
matching identity claim, the exact failure mode P02 already closed off for
award history. Setting `vehicleAccessRequired: true` anywhere in
`funding-opportunities.service.ts` without a genuine, structured, per-
opportunity vehicle signal — which does not exist as of this phase and may
never exist without P27's crosswalk actually being built. Computing
`configured`/`neverSynced`/expiry any way other than reading the REAL
`TANGO_GATEWAY.configured` flag and P15's own checkpoint/snapshot tables —
inventing a client-side proxy for either would silently drift from what
P22's own sync actually knows.

---

## D-45 · 2026-08-07 · Forecasts are richer than P14 found, in three confirmed ways — all three blocked by the SDK's OWN client-side gate, not the live server

P24's live-key investigation started from P14's own documented finding:
"the provider's forecast model is THINNER than the plan assumed... no
anticipated SOLICITATION date, no PSC, no estimated value." That finding
holds — all three are still genuinely absent. But the plan also asked for
an organization hierarchy, a contact, and "provider modification", and a
direct read of the live server's own `available_fields` payload (forced by
requesting a deliberately bogus field, the same technique D-41 used) showed
all three exist, none of them declared in `@makegov/tango-node@1.1.0`'s
bundled `FORECAST_SCHEMA`:

1. **`organization`** — a real nested hierarchy (`department_code`,
   `department_name`, `agency_code`, `agency_name`, `office_code`,
   `office_name`, `organization_id`), confirmed on a real live record
   (VA, "Emergent Virtual Face-to-Face (VF2F) Network").
2. **`modified` and `created`** — real timestamps. `mapForecast`'s own
   pre-P24 comment said forecasts "carry NO modified stamp at all" — true
   against the SDK's typed method, which has no `modified` field to
   request; false against the live server, which has always had one.
3. **`primary_contact`** — a structured `{name, email, phone, title}`
   object on the live server, despite the SDK's own schema declaring it
   `type: "str"`. Confirmed on the same real record: a name and a working
   `@va.gov` email, not a bare string.

**This is a DIFFERENT failure shape from D-35 and D-41, and the fix is
correspondingly different.** D-35's `entity_structure` was rejected by the
LIVE SERVER itself (a genuine server-side incompatibility, unfixable from
Capiro's side). D-41's `parent_uei` was confirmed absent from the live
server entirely (a genuine provider data gap). Here, requesting
`organization`/`modified`/`created` through the SDK's typed
`client.listForecasts(...)` throws `ShapeValidationError` — CLIENT-SIDE,
before any request reaches the network — because `parseShape` validates
against the SDK's OWN bundled schema, which simply does not declare these
fields. The identical shape string, sent via `client.http.get('/api/forecasts/',
{shape, ...})` — the SDK's own HTTP transport, bypassing only its shape
validation — succeeds against the SAME live server without complaint.
There is no live-server rejection to work around; the SDK's client-side
gate is the only obstacle.

**Fix:** `tango.client.ts`'s `listForecasts` calls `rawForecastsGet` (a
small module-level helper) instead of `c.listForecasts(...)`.
`TangoClient.http` is declared `private` in the SDK's own `.d.ts` — a
compile-time-only restriction; the underlying `HttpClient` instance
genuinely exists at runtime — so this is a deliberate, documented,
type-cast escape hatch, not an accident. Every OTHER list method in
`tango.client.ts` still goes through its typed SDK method, because every
other method's bundled schema is complete enough not to need this. `FORECAST_FIELDS`
now requests `organization(agency_code,agency_name,department_code,
department_name,office_code,office_name,organization_id)` and `modified`;
`mapForecast` flattens the organization hierarchy onto `TangoForecast` and
parses `primary_contact` into a real `TangoForecastContact` object instead
of a string; `provenance.providerUpdatedAt` is finally real for this
resource, sourced from `modified`.

**What this forbids:** trusting a `ShapeValidationError` from the SDK's
typed methods as proof a field does not exist on the live server — the
correct next step, demonstrated here, is reading the live server's own
`available_fields` directly (via a bogus-field probe, or the raw HTTP
transport) before concluding a field is unreachable. Reverting
`listForecasts` to the SDK's typed method without first re-confirming, via
the SAME technique, that a newer SDK release has caught up its bundled
`FORECAST_SCHEMA`.

---

## D-46 · 2026-08-07 · tango_procurement_forecast is a single current-state table, not another versioned snapshot layer

P19, P20 and P22 each write their provider observation to the GLOBAL,
versioned `tango_resource_snapshot` (P15) in addition to their own
summary/status columns. P24 deliberately does not.

`tango_resource_snapshot`'s versioned-head design exists to keep a full
audit trail of every observed value for a resource Capiro reaches through a
narrow, LOW-volume path — a specific client's UEI (P19), a specific
relevant vehicle (P22). A forecast has no such narrowing: the live catalog
is ~24,700 rows (confirmed via `count` on an unfiltered live call) and every
one of them is a candidate Capiro might care about. Writing a full version
history for a HIGH-volume catalog resource that changes as fluidly as a
"planned procurement" listing does would grow `tango_resource_snapshot`
by an order of magnitude for a benefit (a full history of every wording
tweak to a still-planned buy) nobody asked for — the plan's own acceptance
bar asks only that "a modified forecast preserves change history/snapshot"
in the sense of "the CURRENT state is accurate and idempotent," proven by
"duplicate provider pages do not duplicate forecasts" sitting right next to
it in the same list.

So `tango_procurement_forecast` is designed the same way `sam_opportunity`
and `federal_grant` (P00) already are: one row per provider id, upserted on
every sync, holding both promoted columns for the fields worth indexing
and querying (`fiscal_year`, `agency`, `provider_modified_at`) and a
`snapshot` JSONB column carrying the full normalized shape of the most
recent observation, for audit and debugging. An upsert overwrites
`snapshot`; it does not grow a new row. `sync-tango-forecasts.ts`
therefore never calls `TangoStoreService.writeSnapshot` — it uses the
STORE only for `readCheckpoint`/`writeCheckpoint` (resumability and the
incremental window), which is a concern orthogonal to whether the data
itself is versioned.

**What this forbids:** adding a version-history mechanism to
`tango_procurement_forecast` to "match the other Tango tables" without a
concrete, stated need for it — the mismatch with P19/P20/P22 here is
deliberate, not an oversight, and is exactly the kind of thing a future
"consistency cleanup" could accidentally undo. If a genuine need for
forecast version history emerges later (e.g., tracking how an anticipated
award date has slipped over time), that is a new, separate table to design
against that specific question — not a retrofit of `tango_resource_snapshot`
onto a resource shape it was never sized for.

---

## D-47 · 2026-08-07 · Forecast recommendation stays a pure, unwired function — and a real title-resolution bug found while proving it stays safe

P25's plan lists four files: `forecast-relevance.ts`, its spec,
`opportunity-recommendation.ts`, and `funding-opportunity-inbox.service.ts`.
No producer script, no new Prisma model, no DI-registered service calling
`FederalBusinessProfileService`/`AcquisitionPositionService` live. That
file list, read literally against "ship logic dark" (this phase's own ship
instruction), is the specification: the SCORING FUNCTION exists, complete
and exhaustively tested; nothing yet calls it with real signals gathered
from a real client and a real forecast. That wiring — a producer that
proposes `client_funding_opportunity` rows for relevant forecasts, the
thing that would make "forecasts can enter the inbox" observable in a real
tenant — is P26+ scope, not this one.

**`shape_now` maps to `'monitor'` in the common vocabulary, never
`'pursue'`, and this is load-bearing, not stylistic.**
`FundingOpportunityCounts.pursuing` and the inbox's own `pursuing` filter
predicate are keyed on `workflowStatus`/`humanDecision` alone — confirmed
by reading both directly, neither has a source-aware carve-out to add one
later. A forecast whose `machineRecommendation` ever reached `'pursue'`
would count toward pursuit-stage KPIs the moment a producer existed to
propose it, with no additional code required to make that happen — exactly
what "not pursuit-stage KPIs until a human explicitly qualifies them"
(this phase's own acceptance line) forbids. Mapping `shape_now` to
`'monitor'` closes that door structurally, at the vocabulary level, rather
than relying on every future caller remembering not to open it.

**A real bug, found while proving the boundary above stays where the plan
puts it.** Extending `funding-opportunity-inbox.service.ts` was scoped down
to the minimum defensible touch: NOT a new write path, NOT widening
`OPPORTUNITY_SOURCES` — just making the EXISTING generic-identity read
path (P13's own `sourceRecordType`/`sourceRecordKey` columns, present on
`client_funding_opportunity` since that phase) actually resolve a title.
Tracing exactly why it did not already work found `titlesFor`'s lookup key
was built from `` `${row.source}:${row.grantOpportunityId ?? row.samOpportunityId ?? ''}` `` — never consulting `sourceRecordKey` at all. A row
addressed purely through the generic identity (both legacy pointers null,
exactly what P13's own DB CHECK constraint already requires for any
non-legacy source) computed an empty-id key and ALWAYS rendered "Source
record no longer in the catalog" — not because the record was gone, but
because this function never knew to look. `readSourceRecordId` (P13's own
dual-read helper, already used two lines below for the row's OWN
`sourceRecordId` field) was sitting unused for exactly this purpose. No
producer writes an `agency_forecast` row today, so this was unreachable
with live data — same shape of finding as D-41/D-44's other dormant-but-
tested paths — but it was a real, findable defect in the meantime for
anyone reaching this path by hand, and is now fixed and proven both ways
(a forecast row WITH a matching catalog entry resolves its real title; one
WITHOUT still honestly says "gone").

**The boundary this fix does NOT cross, proven as tests, not just
asserted in prose:** `funding-opportunity-identity.spec.ts`'s own P13-era
guard (`'no new source is enabled by this phase'`) scans a fixed file list
for the literal string `'agency_forecast'` and fails if it appears —
correctly, since this phase's touch to `funding-opportunity-inbox.service.ts`
does now contain it. Rather than work around the string (e.g., referencing
`SOURCE_RECORD_TYPES` instead of the literal, which would satisfy the scan
without satisfying its actual purpose), the guard was narrowed HONESTLY:
`funding-opportunity-inbox.service.ts` moved out of the blanket "never
names a planned source" list into its own describe block asserting the
exact, narrower thing that stayed true — no
`clientFundingOpportunity.create/update/upsert` call anywhere in the file
(the exception is read-only by construction), `OPPORTUNITY_SOURCES`
unchanged, and the `?source=` query-param filter still only accepting the
two legacy sources.

**What this forbids:** adding a `ForecastRelevanceService`, a producer
script, or any DI wiring that calls `scoreForecastRelevance` with real
data under this phase's own commit — that is a deliberate, separate,
later decision (P26+), not an oversight here. Any future write path for an
`agency_forecast`-sourced `client_funding_opportunity` row must widen
`OPPORTUNITY_SOURCES` and update `funding-opportunity-identity.spec.ts`'s
guard explicitly when it does — the point of narrowing the guard here
rather than deleting it is that the NEXT boundary-crossing gets caught by
a failing test too, the same way this one was.

## D-48 · 2026-08-08 · A migration that only ever failed against real Aurora

Carried forward from the P36 handoff, which asked for this entry and never got it.

`20260822010000_pe_budget_phase7_canonical_promotion` — a Phase 7 Workstream D
migration, not this program's — contained
`ALTER ROLE capiro_pe_promoter NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
That statement requires the *calling* role to itself hold real `SUPERUSER`.
Aurora's master user holds only the restricted `rds_superuser` pseudo-role, so it
failed **every real deploy** with `permission denied to alter role`, and because
Prisma runs each migration file in one transaction, the whole file rolled back —
silently, for as long as the migration existed.

**Why it was invisible:** local rehearsal runs as a Postgres superuser, which
really does hold `SUPERUSER`. The migration passed every rehearsal it was ever
given and failed every deployment it was ever part of.

**What this forbids:** asserting role attributes with `ALTER ROLE` in any
migration that must run on Aurora. Every attribute that line named is already
`CREATE ROLE`'s own default for a bare `CREATE ROLE ... LOGIN PASSWORD`, so
nothing needed re-asserting. **The general rule: a rehearsal that runs with more
privilege than production is not a rehearsal of production.**

## D-49 · 2026-08-08 · 23 EventBridge rules follow whatever migrate revision is latest

**27 rules target the `capiro-dev-api-migrate` task-definition family. 23 are NOT
revision-pinned, and 16 of those are ENABLED.** Measured across every rule in the
account, not inferred; the enumeration command is in rollout runbook §30.

An unpinned ECS target runs whatever revision is latest **at fire time**. So
registering a new migrate revision — which every migration deploy does — silently
changes the container image for 16 scheduled jobs, among them
`sync-sam-opportunities`, `enrich-grant-details`, `sync-federal-award`,
`refresh-memory-graph`, and both clio jobs.

**Two consequences worth internalising.** A migrate task exiting 0 **may not be
your run** — one of those rules firing produces a task in the same family that
exits 0 having run something else entirely, so check `startedBy` before believing
an exit code. And registering a migrate revision deserves the care of a deploy,
not of a config change.

**Deliberately NOT fixed by pinning.** A pinned rule stops receiving migrations,
which is its own failure mode. The correct fix is repointing them at the
already-existing `capiro-dev-api-sync-jobs` family — a reconciliation with its own
blast radius, not a rollout-time change.

The prior handoff described this as "two clio rules." It is 23. The difference
matters because two is a curiosity and 23 is a deployment mechanism nobody
declared.

## D-50 · 2026-08-08 · `.sql` has no `eol=lf` rule, and a spec paid for it

Carried forward from the P36 handoff.

`.gitattributes` normalizes `.sh`, `.ts` and `.md` to LF but says nothing about
`.sql`. On a Windows checkout the Phase 7 migration file therefore reads back
CRLF, and multi-line literal assertions in `canonical-promotion-schema-v1.spec.ts`
silently stopped matching.

**Fixed by normalizing the spec's own read of the file to LF, not by touching the
migration's committed bytes** — an applied migration's checksum must not change.
Adding `*.sql text eol=lf` remains **not done**: it would rewrite line endings
across every checked-in migration, a far larger blast radius than the problem.
Recorded so the next migration-content test does not rediscover it.

## D-51 · 2026-08-08 · Assert by executing SQL, not by asserting its objects exist

This program's unit specs drive services against in-memory port doubles. That is
the right way to test branching, and it is exactly why `$queryRaw` /
`$executeRaw` can be merged **having never run once**.

Two defects proved it in one session:

- **P48's alert INSERT used `ON CONFLICT ON CONSTRAINT "tango_event_alert_dedupe_uniq"`.**
  That name is a unique **INDEX** (`CREATE UNIQUE INDEX` / Prisma `@@unique`), not
  a CONSTRAINT, and Postgres resolves that form only against real constraints. It
  threw on **every** call — the drain would have retried each event five times,
  quarantined it, and written no alert at all. P48 entirely non-functional, with a
  green test suite.
- **P49's canary diagnostic named `tango_entity_profile`**, a table that has never
  existed in any migration (P19 writes `resource_type='entity'` rows into
  `tango_resource_snapshot`), and a column `agrees` when the real one is
  `agreement`.

**The migration rehearsal did not catch the first one, and could not have:** it
asserted *the index exists*, which is a different claim from *the statement the
drain issues actually runs*. The CI migration job now **executes** that INSERT
twice and requires 1 row then 0.

**The rule: for any code that emits raw SQL, assert by EXECUTING the statement
against a disposable database, not by asserting the schema objects it references
are present.**

## D-52 · 2026-08-08 · A failed query is not an absent value

P49's diagnostic wrapped every query in a `try/catch` returning `null`, and `null`
rendered as an em dash — visually identical to a genuine absence. Three broken
queries therefore read as three empty datasets, in the one tool whose entire job
is telling a canary reviewer what is true. **A confident wrong answer is worse
than a crash.**

A failed query is now its own value and prints `QUERY FAILED <reason>`; the em
dash is reserved for real absence; `hasQueryFailure()` lets a caller distinguish
them. It is the same rule this program already applies to money — *"the source
stated nothing" is not "the source stated zero"* — finally applied to the
diagnostic itself.

**Corollary, applied at the same time:** only `agreement = 'conflict'` counts as a
parity disagreement. `local_only` and `provider_only` mean one side has no value —
absence, not contradiction — and counting them inflates the single number a
reviewer is most likely to act on.

## D-53 · 2026-08-08 · Provider list endpoints are walked to exhaustion

`PaginatedResponse` carries `count` / `next` / `results`: the webhook endpoint and
alert list endpoints are paginated, and the adapter read page 1 only.

The original justification — *"an account with enough alerts to need pagination
would already have violated the one-alert-per-dataset rule"* — was wrong in the one
direction that matters. **The account also holds alerts a human created in the
MakeGov dashboard, and this program controls none of them.** A Capiro-managed alert
on page 2 would have been diffed as absent and re-created, colliding on its own
name.

Both lists now walk until a page comes back short, and a provider that never ends
**throws** rather than returning a partial list. This restores the rule P03/P04
exist to enforce: no silent caps, completion is algorithmic. A reconciler acting on
half the picture is exactly what that rule is about.

## D-54 · 2026-08-08 · "Not caused by us" is not "not ours to fix"

Three consecutive handoffs recorded the two failing
`App.funding-opportunities-nav.test.tsx` tests as "`EngagementPreviewBoundary` calls
`useQueryClient()` outside a provider — traced to PR #813, not this program's code,
owned by whoever owns Engagement."

Half right about the mechanism, **wrong about the owner.** The component is correct.
What #813 changed is that **`App` itself began requiring a `QueryClientProvider`** —
and two tests *in this program's own file* still rendered `<App />` bare, while a
`renderAppWithRouter` helper supplying one sat a few lines above them. The fix was
four lines.

*"Reproduced with only pre-existing files"* correctly established that our changes
did not **cause** it. It never established that the fix belonged to someone else.
**Collapsing those two into one finding cost three sessions of a red gate.**

## D-55 · 2026-08-08 · P46–P51 merged without the §6.2 independent review

Recorded because it is a deviation from this program's own gate, not an oversight
to be discovered later.

§6.3 permits a merge only after an independent PASS and green CI on the final SHA.
Neither held. Account-wide GitHub Actions has been down since 2026-07-31, so "green
CI on the final SHA" cannot be satisfied by waiting; and §6.2's independent tester
requires a context that did not write the code, which the implementer cannot be.

**Merged anyway, on Neo's standing instruction to complete all phases**, with both
gates verified green locally (api 78/2454, web 412/412) and every PR
`MERGEABLE`/`CLEAN`. All merges are ordinary merge commits and revert cleanly with
`git revert -m 1 <merge-sha>`.

**What this means for anyone reading the completion matrix:** every row in it, for
P00–P51 and not merely for these six, is *self-verified only*. The
independent-review column is empty because the review has never happened, not
because it passed.

## D-56 · 2026-08-08 · A per-event insert loop is not idempotent recovery, it is a new data-loss path

A third independent review of the fixes for the fixes for the fixes (§ this is not a typo — three rounds
deep) found that the N1 fix from the previous round introduced its own defect: `enqueuePendingDeliveries`
enqueued one outbox row per event via a loop of separate, independent `$executeRaw` statements. If that
process died — a crash, a task timeout, a redeploy — after inserting row 0 of a 3-event delivery but
before rows 1 and 2, the enqueue SELECT's own "already enqueued" check (`o.id IS NOT NULL` for that
delivery) saw that a row existed and never revisited it. Events 1 and 2 were lost **permanently**: the
receiver never re-delivers (delivery_id is unique there too), and nothing downstream reconciles a
partially-enqueued delivery.

This is the SAME failure class this program has now hit three times in three different shapes — accepted
at one layer, silently dropped at the next — and this was the third round's own fix introducing a fourth
instance of it, narrower each time.

**Fixed by making it structurally impossible, not by sequencing more carefully.** Each delivery's N
inserts now run inside one `$transaction`. Proven two ways: a unit test against a fake whose
`$transaction` has real commit/rollback semantics (a throwing callback commits nothing), and — because a
fake, however faithful, has twice now been shown insufficient this session — a throwaway script against
REAL Postgres 16 confirming a transaction that throws mid-way genuinely leaves zero rows in the actual
database, and that the real exported function correctly enqueues all three events of a real webhook
delivery row.

**The general rule, restated because it needed restating a fourth time:** a loop of independent
statements over "the parts of one logical unit of work" is not idempotent just because each statement
individually has a conflict guard. Idempotency of the parts does not give you atomicity of the whole.

## D-57 · 2026-08-08 · Per-event classification never ran, and the test proving it used an impossible input

Review 3 also found: `readResourceRefs`' per-event type classification checked the DELIVERY's own
`event_type` before the event's own type (`eventType || <event's own type> || ''`). The delivery's
`event_type` comes from `tango_webhook_delivery.event_type`, which a CHECK constraint forbids being blank
and `readEnvelope` never lets through empty — so the left side of that `||` always won, and the per-event
branch was dead code. A batch mixing `opportunity.updated` / `forecast.updated` / `entity.updated` events
classified every one of them as whatever the delivery header said.

**The test that was supposed to catch this passed `eventType: ''` — an input production cannot generate.**
This is the second time this exact failure mode has appeared in three rounds: a test shaped to make a
claim pass, rather than shaped to check whether the claim is true against realistic input. Review 2 found
the first instance of this pattern (N1's original test enshrined the very discard it should have caught);
this is the second, in a completely different function, written by the same round of fixes that fixed the
first one. **That recurrence is more informative than either individual bug**: it suggests a systematic
gap in how fix-round tests were being constructed, not two unrelated mistakes.

Fixed by inverting the precedence: an event's own type wins when present; the delivery's type is the
fallback ONLY for a single-event body whose envelope carries no type key of its own. New test uses a
realistic, non-empty delivery-level type (`'opportunity.updated'`) alongside three differently-typed
events, and separately checks the single-event fallback still works.

**A related, smaller defect fixed at the same time:** `event_index` was computed as the position within
the events array AFTER filtering out non-object entries, so `['junk', {...}]` numbered the real event 0
instead of 1 — silently violating the documented contract on a column that is part of the idempotency
key. Fixed to preserve the true array position through filtering.

## D-58 · 2026-08-08 · The alert-volume cap bounds one EVENT, not a delivery and not a run

Review 3 found the volume cap added the previous round only tracks alerts written from the unit
currently being processed. Review 4 then found THIS ENTRY'S OWN DESCRIPTION of that unit was wrong,
and wrong in the direction that understated the problem: the counter resets inside `processOne`, which
runs once per CLAIMED OUTBOX ROW — and the same session's per-event outbox change made that unit one
EVENT, not one delivery. The constant has been renamed `MAX_ALERTS_PER_EVENT_PER_CLIENT` so its name
states the bound it actually enforces. The two units coincide only for a single-event delivery, which
is why the imprecision survived a round. Recording that here rather than quietly correcting it: an
admission that names the wrong unit is not a smaller version of the problem, it is a different claim,
and "we already wrote this one down" is exactly the reason it went unchecked for a round. A second, ordinary delivery over the
same long notice history re-walks it, dedupes what the first delivery already wrote, and writes MORE up
to its own cap — so two deliveries together can still deliver an entire backlog, just spread across two
runs instead of one. The docstring's claim that capped changes are "left on the P28 timeline" for later
is not really true in the sense a reader would expect: they are not skipped, they are deferred to
whichever delivery happens to touch that opportunity next.

**Deliberately NOT fixed in this round.** The correct bound is almost certainly "per opportunity per
client per some *time window*", not "per delivery per client" — which needs a decision about what that
window is and where its state lives (a new column? a separate rate-limit table?), not a quick patch. Given
this session's own track record — three straight rounds where a fast, locally-reasonable fix introduced a
new defect the next review caught — writing that design decision under time pressure right now would very
plausibly repeat it a fourth time. Recorded here, and in the rollout runbook's suppression-reason table, so
the actual behavior (capped per delivery, not per run) is what an operator reads rather than what the
comment used to imply.

## D-59 · 2026-08-08 · Atomicity via ONE statement, not via a transaction with a timeout

Review 4 confirmed D-56's atomicity fix worked for the crash it targeted — verified against real
Postgres with a trigger raising mid-batch — and then found the fix had introduced a worse failure than
the one it closed. Wrapping a delivery's N per-event inserts in `prisma.$transaction` inherits Prisma's
default **5-second interactive-transaction timeout**, measured to bite at roughly 3000 sequential
inserts. A 3000-event batch of minimal event objects is ~152KB — comfortably inside the webhook route's
existing 1MB body limit, so a legitimately-sized delivery the receiver had already accepted with a 202
could trip it.

Worse than the bug it replaced, in the specific way that matters: the failure is **not transient**. The
event count and per-statement latency are identical on every retry, so the delivery fails the same way
forever; deliveries are drained oldest-first; and the enqueue loop has no per-delivery `try`/`catch`. One
oversized delivery would therefore jam **every delivery queued behind it**, permanently. That is the same
"accepted at one layer, stuck at the next" shape this program has now hit four times — the fourth
introduced by the fix for the third.

**Fixed by removing the failure class rather than moving its threshold.** A delivery's rows now go in as
one `INSERT ... SELECT FROM unnest(...)` statement. Postgres applies a single statement atomically by
construction, so atomicity costs nothing and needs no transaction, no interactive-transaction machinery,
and no timeout to size a batch against. It is also one round trip regardless of N.

`unnest` of five ARRAYS specifically, not a multi-row `VALUES (...), (...)`: `VALUES` binds five
parameters per row against Postgres's 65535-parameter statement cap, which would have reintroduced a hard
ceiling near 13k events — higher than the 5s cliff, still a cliff, and still reachable inside the 1MB body
limit. Five arrays bind five parameters total for any N, so no event count breaks it.

Raising the transaction timeout was considered and rejected: it would have picked a new number for the
same cliff, and the number that is obviously safe today is a function of row width, index count, and
database load, none of which are stable.

Verified against real Postgres 16, 10/10: arrays bind as real `text[]`/`int[]`; 3000 events (the size that
previously timed out at 5009ms) now completes in **113ms**; 20000 events — past the `VALUES` parameter
ceiling — completes in **477ms**; nulls survive the `text[]` round trip with indices intact; a trigger
raising mid-statement leaves **zero** rows and the delivery then retries to a complete set; and two
concurrent drains racing the same delivery converge to exactly the right row count with no duplicates and
no deadlock.

One consequence worth stating: a PARTIAL set of outbox rows for a delivery is now unreachable — the atomic
statement is the only writer and nothing in the codebase deletes outbox rows — which is what makes the
enqueue filter's "any row exists means already enqueued" test sound rather than lossy. That filter was the
mechanism by which the original D-56 bug lost events permanently; it is safe now only because partial sets
cannot occur. If anything ever starts deleting outbox rows, that reasoning breaks and this filter has to
be revisited.

## D-60 · 2026-08-08 · A dry run must report the same unit the commit reports

Review 5 — scoped to the D-59 rewrite alone, and the first PASS in five rounds — found that
`enqueuePendingDeliveries` returned a count of **deliveries** on the dry-run path and a count of
**events** on the commit path, both surfacing as the same `enqueued` field. Two deliveries carrying 3 and
2 events produced a dry run promising `2` and a commit writing `5`.

This was not introduced by the D-59 rewrite; it dates from the per-event outbox widening earlier in the
same session. Before that change the outbox held one row per delivery and the two units genuinely
coincided, so the correspondence broke silently rather than visibly — nothing failed, the number just
quietly stopped meaning what the flag promises.

It understates rather than overstates, so it was never a safety problem. It is a **credibility** problem,
and specifically for the one feature this whole CLI is built around: dry-run-first. A dry run whose
number does not predict the commit is not a preview, and every mutating command in this program advertises
that it is one. Fixed by computing the same per-event sum on both paths, with a test asserting the two
return the identical number rather than merely asserting each in isolation — the latter is what let them
drift apart.

Two further findings from the same review were left alone deliberately. Concurrent drains each report the
full count when they race (the ROWS are correct and verified — exactly 2000 with no duplicates — only the
aggregate log line double-counts). And one replay test exercises a path the pending query's `LEFT JOIN`
makes unreachable in production; its comment now says so, and points at the concurrent-drain race, which
is where `ON CONFLICT` actually earns its keep and which was verified against real Postgres.

## D-61 · 2026-08-08 · Five agent reviews are not the human review the plan asks for

Recorded because the count is now large enough to be misread as a substitute.

Five independent review rounds have run against the P46–P51 event-drain code. Four found real defects the
previous round missed, and three of those four found a defect **introduced by the immediately preceding
fix** — including, twice, a test written to make a claim pass rather than to check whether it was true.
The fifth found the mechanism sound.

The honest reading is both halves at once. The technique works: each round found something real, the
defects got smaller and more specific, and the last round's finding was a unit mismatch in a return value
rather than a data-loss path. And it is not the gate §6.2 specifies. Every one of those reviewers was an
autonomous agent briefed by the same author as the code, and the recurring failure — a test shaped to
pass — is exactly the failure an author-adjacent reviewer is worst positioned to catch, which is presumably
why the plan asks for a human.

No phase in P00–P51 has been read by a human other than its author. That remains true, and five agent
rounds on one feature does not change it for that feature, let alone the other 46 phases.

## D-62 · 2026-08-08 · CORRECTION: P40–P43 were never blocked on the provider

**This entry corrects a claim this program recorded in at least five places and repeated for a day.**

The completion matrix, this log, P17's capability report, the P46–P51 handoff, and the project closeout
all stated that DIBBS and SBIR/STTR have **no API surface**, and that P40/P42 were `blocked` on MakeGov
shipping one — with the explicit note that this was "not a scheduling choice."

What was actually verified was narrower: `@makegov/tango-node@1.1.0` exposes no DIBBS or SBIR method. That
is true, and was re-confirmed on 2026-08-08 by a full-text scan of the installed package finding zero
occurrences of dibbs/sbir/sttr anywhere in it.

**"Not wrapped by the SDK" was then written down as "does not exist."** Both datasets have a fully
documented REST API — `/api/dibbs/rfqs/`, `/api/dibbs/rfps/`, `/api/dibbs/awards/`, `/api/sbir/topics/`,
`/api/sbir/solicitations/` — published at docs.makegov.com. The contract is transcribed into
`dibbs-sbir-rest-contract.md`.

The failure is worth naming precisely, because "verify your claims" is too general to be useful here. The
SDK scan was rigorous, repeated, and correct. **A negative finding carries the scope of the instrument
that produced it** — an SDK scan can only establish an SDK fact. Promoting it to a provider fact required
an assumption that was never written down, and therefore never checked. It survived five independent
review rounds because every one of those reviews was scoped to the event-drain code; nobody was ever asked
to review the blocked-status claim, and a blocker is exactly the kind of conclusion that stops attracting
scrutiny once recorded.

Two things that do NOT change:

1. **The entitlement gate stands.** The plan's "API key: Required; P17 must show access" is unaffected —
   endpoints existing says nothing about whether Capiro's plan is entitled to them, which is what P17's
   probe was for and which only a real call with a real key can answer.
2. **The prohibition on guessing stands.** D-35, D-41, D-42 and D-45 forbid writing a sync against an
   endpoint shape nobody has confirmed. That is why the contract document marks every field type, null
   semantic, date format, and the pagination envelope as UNCONFIRMED: the docs give field names, not
   types, and P40's own acceptance requires "quantity/unit/money null semantics pass." Mappers built from
   this document are provisional until one live response validates them.

What genuinely changes: P40–P43 move from `blocked` to `buildable, unverified`. Schema, migrations,
mappers, sync scripts, fixtures, tests, dispatcher verbs and disabled schedules can all be written now.
Only the entitlement probe and live sync still need a key.

## D-63 · 2026-08-08 · The DIBBS sync keeps no checkpoint, and the window is an issue-date window

`sync-tango-dibbs` is the first Funding Opportunities sync that does **not** resume from
`TangoStoreService`'s checkpoint. Two independent reasons, and the second matters more than the first.

**It is unstorable.** `tango_sync_checkpoint.resource_type` carries a CHECK admitting exactly
`entity, opportunity, notice, forecast, vehicle, vehicle_awardee`
(`20260821010000_tango_source_substrate`). No migration has ever widened it, and P40's own
`20260908010000_tango_dibbs` does not either — it creates two tables and touches nothing else. A DIBBS
checkpoint row cannot be inserted. This was found while writing part 3, not while planning it: the part-3
brief specifies "incremental" and every prior sync in this program gets incrementality from that table, so
the gap was invisible until someone tried to write the row.

**It would be the wrong abstraction even if it fit.** A checkpoint stores a modification-time high-water
mark. DIBBS publishes no `modified_after` filter — the documented filters are `issue_date_after`,
`issued_date_after` and `posted_date_after`. Storing an "as of" instant would encode a guarantee the
provider never offered, and the CHECK constraint merely made that visible early.

So the window is derived from the data the sync already wrote — the newest issued/posted date per
endpoint, minus an overlap — and every run's summary states the window it actually used.

**The consequence that must not get lost:** an issue-date window selects records *issued* since a date. A
solicitation amended after issue does not re-enter it, so an incremental run will not see the amendment
and will still report itself `complete`. This is a permanent limit of the published filter set, not a
tuning problem. The mitigation is `--full`, which drops the window and reconciles the whole catalog; the
upsert keys on the provider's own `uuid`, so a full run is idempotent. The shipped (disabled) schedule
therefore pairs a daily incremental with a weekly `--full`, the same shape as the LegiStorm directory pair
in `ingestion-schedule.ts`. **A schedule that only ever runs the incremental will drift, silently.**

Widening the checkpoint vocabulary in a later migration is still open as an option, but it should not be
done merely to make DIBBS look like the other syncs — the modification-window semantics would still be
absent, and a checkpoint row implying otherwise is worse than no row.

## D-64 · 2026-08-08 · The P17 probe had D-62's error compiled into it, and a test holding it in place

D-62 corrected the claim in prose. It did not correct the code that produced the claim.

`tango-capability-probe.service.ts` carried `dibbs` and `sbir_sttr` probes with `call: null` and
`skippedReason: 'unsupported_by_provider'`, which this file's own `ProbeDef` doc defines as "a genuine SDK
gap … a fact about the provider/SDK surface itself". The `dibbs` reason read: *"P40 cannot assume this
dataset is reachable through this SDK version; escalate to MakeGov before designing P40 around it."*

So `p17-tango-capability-report.json` — the artifact attached to a handoff, and the thing a reader
consults to answer "is Capiro entitled to this dataset" — asserted that a dataset with a published REST
API was unsupported by the provider. Worse, **a test pinned it**:
`expect(byKey(report, key).status).toBe('unsupported')` over a list including both keys. The error was
load-bearing in three places at once: a service, a report, and a green assertion.

Corrected here:

- A fourth `skippedReason`, `no_rest_client_wired` → `not_attempted`. "Capiro has not built a client"
  is a fact about Capiro's code; `unsupported` is a claim about the provider. Conflating them is the
  whole of D-62 in one enum value.
- `dibbs` is now a REAL probe when a `TangoDibbsClient` is supplied — one read-only
  `listRfqs({ limit: 1 })`, the same smallest-shaped-call policy as every other probe here.
- `sbir_sttr` stays uncalled (P42/P43 have not built a client) but now reports `not_attempted` with a
  reason stating the provider **does** document `/api/sbir/topics/` and `/api/sbir/solicitations/`, and
  that entitlement is therefore **unknown, not refused**.
- The test that pinned `unsupported` for both keys now asserts the opposite: `unsupported` for these two
  is a regression, not a baseline.

**`p17-tango-capability-report.json` (captured 2026-08-07) is left unmodified — it is a record of a real
run, and editing a captured artifact to match a later understanding is how records stop being evidence.
Its `dibbs` and `sbir_sttr` rows are SUPERSEDED and must not be cited. A re-run answers them.**

The generalisable point is narrower than "update code when you update docs": **a correction that lands
only in prose leaves the mechanism that generated the error still running.** D-62 was written, reviewed
and merged while the probe kept emitting the corrected claim, and a passing test kept it there.

## D-65 · 2026-08-08 · P17 answered: DIBBS is entitled, and the run found two defects

The corrected probe was run against the real account (operator-run, outside any agent session, key pulled
from Secrets Manager and never displayed). Result:

**`dibbs`: `supported`. P40's entitlement gate is CLOSED.**

A second result comes free, and it is the more valuable one. The probe calls `listRfqs({ limit: 1 })`
through `TangoDibbsClient`, which **throws** `TangoDibbsEnvelopeError` when a 200 response carries no
`results` array. It returned "Call succeeded." **So the pagination envelope is confirmed to be
`results`-shaped against a live response** — the single largest unknown in P40.

Scope that precisely: the probe never captures response bodies, so this confirms the ENVELOPE only. Field
types, null semantics and date formats in the mappers remain unconfirmed readings of published names.
`sbir_sttr` remains `not_attempted` — no client exists yet, so entitlement there is still unknown.

### Defect 1 — the DIBBS sync had no rate-limit handling whatsoever

The run measured this account at **25 requests per ~31 seconds** (`x-ratelimit-limit: 25`,
`resetIn: 31`). That is small enough that a page-complete catalog walk reaches it routinely.

`sync-tango-dibbs.ts` as first written had no handling for it. `sync-tango-forecasts` wraps its gateway in
`TangoResilienceService`; the DIBBS sync talks to its REST client directly, and its only `try/catch` was
around the upserts. A 429 would have propagated out of `walkEndpoint` and **killed the entire run — all
three endpoints, not just the throttled one.** Fixed here:

- `TangoDibbsHttpError` now carries the failing response's rate metadata, so `Retry-After` can be
  honoured rather than guessed. Guessing is worse in both directions.
- Bounded retry on 429 (default 5), preferring `Retry-After`, then `resetIn`, then a fixed fallback.
- Proactive throttle: a page reporting `remaining: 0` pauses before the next request instead of spending
  a request to learn what the previous response already said.
- **A rate limit that outlasts the retries stops ONE endpoint and leaves it `complete: false`. It never
  aborts the run.** Killing the other two would turn one throttled walk into three unsynced datasets.
- `rateLimited` is surfaced per endpoint AND at run level, because `completeness: in_progress` alone
  cannot distinguish "capped by `--limit`, as instructed" from "the provider throttled us".

**This is what the live gate is for.** No unit test would have found it — the fakes never return 429.

### Defect 2 — a throttled probe was indistinguishable from a broken capability

`budget_accounts_flows` reported `status: "error", reason: "Rate limit exceeded"` because the budget ran
out mid-run. The 2026-08-07 report has it `supported`. A reader diffing the two would have seen a P44
regression that does not exist.

`classifyStatus` already returns a `rate_limit` kind; the probe was collapsing it into `error`. Added
`rate_limited` as its own `ProbeStatus` — **the same reasoning that produced `not_found`**, which this
file's own doc justifies as "collapsing it into generic `error` would make it indistinguishable from a
genuinely broken call." The identical mistake recurred one status over.

The default `--request-ceiling` was also **30 — above the provider's own limit of 25**, so the
self-imposed cap could never bind; the provider always ran out first. Now 25. A full pass needs ~17 HTTP
calls, so it fits on a fresh window. The 2026-08-08 run began at `remaining: 12`, which is why it did not.

---

## D-66 · 2026-08-08 · D-65's ceiling fix was inert, because the only caller passed 30 explicitly

PR #857 merged as `094daf1d`. Three findings while closing out its open items, all in the operator
launcher — which, until now, lived only on one machine and in no repository.

### The fix was real and the tooling overrode it

D-65 lowered the probe's default `--request-ceiling` from 30 to 25, because 30 sits above the account's
25-per-31s limit and so can never bind. But `run-p17-probe.ps1` — the only path anyone actually invokes —
defaulted its own `-RequestCeiling` to 30 and passed `--request-ceiling=30` explicitly. **The merged fix
changed a default that the sole caller was already overriding with the exact value the fix removed.**

Generalisable, and the reason these files are now vendored: **a default is only a fix if no caller
overrides it, and a fix merged into the repo does not reach tooling that lives outside the repo.** The
scope of a fix is the scope of the artifacts it touches — the same shape as D-62 (an SDK scan can only
establish an SDK fact) and D-64 (a prose correction leaves the mechanism running). Third time in this
program.

### A captured report was one double-click from being destroyed

`p17.cmd` wrote to a fixed `C:\dev\p17-capability-report.json`. The 2026-08-08 run is the only
live-provider evidence this program has — it answered P17 and found both D-65 defects — and the next run
would have silently overwritten it. Now timestamped per run, defaulting outside the repo, and the runner
refuses to write over an existing file.

This is the same principle that kept `p17-tango-capability-report.json` (2026-08-07) unmodified despite two
superseded rows, applied one layer out: **it is not enough to refuse to edit a record if the tooling
overwrites it on the next run.**

### An action item and its own contraindication, four rows apart

`HANDOFF-2026-08-08-session.md` told the next reader to point `REPO=` at `C:\dev\capirov2` (Open items) and,
four rows later, that `C:\dev\capirov2` sits on `agent/fo-p36-outcome-capture` with other agents on it and
its branch must not be switched (Traps). Both true when written, mutually incompatible as instructions, in
one document from one session.

Following it would have been quiet rather than loud: that checkout contains none of P40's files, so the
probe would have run and reported `dibbs: not_attempted / no_rest_client_wired` — a fact about Capiro's
code wearing the shape of an entitlement answer. **D-64 exactly, one layer out**, which is why the runner
now hard-fails on a missing `TangoDibbsClient` rather than reporting a status.

Generalisable: **a to-do and its contraindication get written in different modes** — planning versus
warning — and neither pass re-reads the other. When a handoff's action list names a path, the trap list is
the thing to check it against.

**Resolved state.** `REPO=` points at `C:\dev\capiro-p17-wt`, a detached worktree at `094daf1d` with deps
installed. `main` itself could not be used: `git worktree add` cannot check out a branch another worktree
already holds, and `C:\dev\capiro-outreach-clamp-wt` holds `main`. Launcher and runner are now vendored at
`operator/`, so the next correction lands in version control instead of on one machine.

**The duplicate copies are retired — done, not pending.** Vendoring briefly created a second copy of the
runner, which is the drift this entry is about, so it was closed out in the same session #860 merged:

- `~\OneDrive\Documents\Claude\run-p17-probe.ps1` — **deleted.** The vendored `operator/run-p17-probe.ps1`
  supersedes it. A stale, unreferenced copy of credential-handling logic is worse than no copy.
- `C:\dev\p17.cmd` — **rewritten as a shortcut with no logic of its own.** It resolves
  `operator/run-p17-probe.ps1` inside `C:\dev\capiro-p17-wt` and passes `-RepoPath`. Its one guard covers a
  missing runner; every real guard lives in the versioned script. Its header says why it is empty.
- `C:\dev\capiro-p17-wt` — moved to a detached checkout of `552df2a1`, so it contains `operator/`. #860 was
  docs-only, so the lockfile did not move and the existing `node_modules` stayed valid.

There is now exactly one copy of the logic, and it is this one. A change made here reaches the operator;
that was not true before #860.

**Not resolved, and not an agent's to resolve:** the Tango API key was pasted into a chat transcript on
2026-08-08 and still needs rotating in Secrets Manager. Until it is, a probe run may report an
authentication failure that looks like an entitlement problem.

## D-67 · 2026-08-08 · A default branch is a claim about every case you did not name

P41 part 3 wired the DLA bid board into the inbox. Adding one entry to the web's `INBOX_SOURCES`
broke a detail surface, and the mechanism is worth recording because neither the compiler nor the
existing tests said a word.

### The bug

`FundingOpportunityDrawer` chose its body like this:

    catalogRef == null ? <ForecastOpportunityDetail/> : <FundingOpportunityDetail/>

That was correct for as long as `agency_forecast` was the only non-catalog rail: "is not a catalog
record" and "is a forecast" named the same set. `asCatalogRef` returns null for a `dibbs` ref too,
so the moment the fourth source became legal, opening a bid-board row fetched
`/api/intelligence/opportunities/forecasts/<solicitation>` and rendered a DLA line item as an
agency forecast — a record type claiming to be a different record type, which is the exact class of
failure this program exists to prevent.

**Typecheck passed.** Both branches accept an `OpportunityRef`; `asCatalogRef`'s contract was never
violated. Nothing was cast. The defect lived entirely in a boolean's *meaning* having quietly
changed while its *value* stayed correct.

The general form: **a default branch encodes "everything else is X", and that claim expires the
moment the set grows.** The fix is not a better default but no default: every rail now has to be
NAMED to get a body, and an unnamed one renders a sentence saying there is no view for it. Wrong in
a way a reader can see, rather than wrong in a way that looks like data.

Worth noting that `asCatalogRef`'s own doc comment had predicted this — it said a cast at each call
site "is exactly the thing that stops the compiler noticing when a third record type arrives." The
third record type arrived and the compiler did not notice, because the hazard was never the cast
that was avoided; it was the `== null` test downstream that had silently become a source test. **A
comment that names a future hazard does not defend against it.**

### The second finding: a null that was not neutral

`DibbsOpportunityCard.partProfileGap` treats `null` as "a part-level match was attempted and there
is no gap". The inbox response carries no scoring breakdown, so `null` was the obvious default —
and it would have told every reader that this client's parts were compared against the item and
came up short. No client part store exists in this schema (`scoreDibbsRelevance` documents
`clientHasRecordedParts` as false for every client), so no comparison has ever run for anyone.

Same shape as the drawer bug one level down: **an absent value is not a neutral value when the
consumer reads absence as a determination.** The gap is now passed from a named constant,
`DIBBS_PART_PROFILE_GAP_TODAY`, whose doc carries this reasoning and which is DELETED rather than
edited when a client part store lands — so the day the fact stops being structural, the constant
stops compiling instead of silently becoming a lie.

### What this part did NOT do

- **The v2 queue surface (`FoV2Queue.tsx`) still branches only on `isForecastRow`**, so a dibbs row
  renders there through the generic treatment. Pre-existing since part 2 made the API return these
  rows to every caller; not introduced here and not fixed here.
- **Prior-award intelligence is not surfaced in the inbox.** `describeDibbsAwardIntelligence` exists
  and the card renders awards, but `InboxDibbsFacts` carries none, so the card is passed no awards.
  Absence renders as no section, not as "no prior awards".
- **No pursuit control.** No mutation is wired for a dibbs row, so the card's action row is absent
  rather than inert — which also means its solicitation-document link, nested inside that row, is
  not reachable from the queue.
- **Still no live DIBBS response has ever been observed**, so every field mapping here inherits
  P40's open contract gate unchanged.

## D-68 · 2026-08-08 · P42's gate could not be satisfied by anything P42's file list contains

P42's plan states **"API key: Required; P17 must show access"** as its gate, and lists six primary
files: the Prisma schema, a migration, `tango-sbir.mapper.ts`, `sync-tango-sbir.ts`, the entrypoint
dispatcher and the ingestion schedule. **None of them can make an HTTP call.**

Meanwhile P17 reported `sbir_sttr: not_attempted / no_rest_client_wired` — which D-64 established is
a fact about CAPIRO'S CODE, not about the provider. Nothing would ever have changed that. Building
the six named files first would have meant designing a schema, a mapper and a sync against
documentation, and only discovering at the end that the phase's own stated gate had never been
answerable.

So part 1 is a file the plan does not name: `tango-sbir.client.ts`, plus its probe wiring. The
reasoning generalises past this phase: **when a phase's gate names an observation, ship the thing
that makes the observation first, even when the plan's file list does not mention it.** Same shape
as P40, whose `tango-dibbs.client.ts` is also absent from its plan's file list and also unavoidable
— the SDK wraps neither dataset (D-62), so a REST client is a precondition for both phases rather
than an implementation detail of either.

Recorded as a deviation because this program's matrix elsewhere claims phases "ship exactly the
file list the plan names, no more" (P25's row), and this one deliberately does not.

### The DIBBS-only guard was one dataset behind

`run-p17-probe.ps1` hard-failed when `tango-dibbs.client.ts` was missing, because a pre-P40 checkout
would run and report `dibbs: not_attempted` — a non-answer that reads like an answer. Correct, and
**it would not have covered SBIR**: the moment this phase made `sbir_sttr` answerable, a pre-P42
checkout gained the identical failure mode one dataset over, and the guard written specifically to
prevent it would have said nothing.

Now table-driven, so adding a rail is a one-line edit rather than a judgement call about whether to
bother. **A guard written against one instance of a class tends to stay that narrow unless the
class is what gets written down.**

### A "no call has been made" note that stopped being true

`dibbs-sbir-rest-contract.md` said flatly that everything in it was transcribed from documentation
and no call had ever been made. True when written; false for DIBBS from 2026-08-08, when P17's probe
confirmed the envelope live (D-65). Now a per-dataset table, because the two rows differ in exactly
the way that matters: DIBBS has one live observation of its ENVELOPE and nothing else, SBIR has
none.

Worth stating plainly, because a `supported` probe row is easy to over-read: **P40 has had a
`supported` DIBBS row since 2026-08-08 and its full contract validation is still open.** One live
call establishes entitlement and the envelope. It establishes no field type, no null semantic and no
date format. A successful SBIR probe will be worth exactly as much.

## D-70 · 2026-08-09 · The migrate image was pruned, 16+ scheduled rules were dead, and the migration debt was already paid

Three findings from one operation. The instruction was "apply the four pending migrations to
`capiro-dev`". None of the three things it uncovered were the migrations.

### The task definition pointed at an image that no longer exists

`capiro-dev-api-migrate` rev 54 pinned
`capiro/dev/api:9b23dc8906f633d5c245fb1f3351874997273351`. That tag is **gone from ECR** — pruned by
a lifecycle policy. Running the task produced `CannotPullContainerError: ... not found`.

So the family could not run at all, and had not been able to for some time.

### Which means 16+ unpinned EventBridge rules were silently failing

This program has carried a documented hazard since P40: *"23 of the 27 EventBridge rules targeting
`capiro-dev-api-migrate` are revision-unpinned, and 16 are enabled, so registering a migrate revision
is a de facto deploy of 16 scheduled jobs."* True when written. **It was inverted in practice.**

Of the recently-stopped tasks in the cluster, **65 of 79 died with `CannotPullContainerError`**, and
the migrate family's own history shows the rules firing and failing by name:

```
events-rule/capiro-dev-run-clio-scheduled-tasks   02:15  CannotPullContainerError
events-rule/capiro-dev-detect-tracker-alerts      02:00  CannotPullContainerError
events-rule/capiro-dev-emit-clio-alerts           02:00  CannotPullContainerError
```

Those jobs were not "about to be deployed by a new revision" — they were **already dead**, and had
been failing every time they fired. Registering rev 55 against a valid image RESTORED them.

Generalisable, and the reason this is written down rather than just fixed: **a documented hazard
describes the system on the day it was written.** This one had quietly become its own opposite, and
every session since had been carefully steering around a danger that had already turned into an
outage. A hazard worth avoiding for weeks is worth re-verifying before the weeks are up.

### And the migrations were already applied

The whole point of the exercise. Rev 55 ran clean (exit 0), and the log reads:

```
256 migrations found in prisma/migrations
No pending migrations to apply.
```

`prisma migrate deploy` names every migration it applies. It applied none, because the ledger
already held all 256 — including `20260909010000_tango_sbir_sttr`, which merged the same day.

**The completion matrix was wrong.** Its Deploy cells said "NOT applied to `capiro-dev`" for P36, P40
and P42, and this session's memory said "four unapplied migrations". Both were reading the same
stale document. ECS retains stopped tasks for roughly an hour and shows no successful migrate run, so
WHEN they were applied cannot now be established — only that they are applied.

The error is the same shape as D-69's, one layer out: **a claim about the live system was carried
forward from a document instead of being checked against the system.** The check costs one task run.
The matrix cells are corrected to say "applied — verified 2026-08-09 by a clean `migrate deploy`
reporting 0 pending", which is a claim with a method attached rather than a status somebody typed.

### What was actually changed

Nothing in the database. `capiro-dev-api-migrate` now has rev 55 pinned to
`capiro/dev/api:90f01afaa440aad1e3b7f15a2b4c077a225849c2` (current `main`, built arm64 and pushed
because repo-wide CI has been `startup_failure` since 2026-07-31 and cannot build one). `:latest`
was moved to the same image.

Deliberately NOT used: `scripts/deploy-dev.sh`, whose migrate path targets
`capiro-dev-api-admin-migrate` — a different family whose rev 9 runs
`prisma migrate resolve --rolled-back <name> || true` before every deploy, auto-resolving the ledger,
which is precisely the behaviour the entrypoint's Phase A hardening removed. No service was rolled.

## D-71 · 2026-08-09 · The contract is validated — a real capture, and two false positives in the tool that took it

The last open question this program carried since P40: every mapper, schema and
scorer in P40–P43 was written against a published field LIST, never against an
observed response. An operator ran `scripts/diag-tango-contract-capture.ts`
against the live provider — five records from each of `dibbs/rfqs`, `dibbs/rfps`,
`dibbs/awards`, `sbir/topics`, `sbir/solicitations`. **`/api/sbir/` had never
been called by anyone, for any reason, before this run.**

### The headline: nothing was wrong

Every mapper, every coercion helper, and the one comparison the SBIR scorer
makes against a status string handled every record in the capture correctly,
with zero code changes. `str()` already collapsed an empty string to null.
`int()` already coerced a numeric string. `decimalString()`'s number branch
already handled a JSON-number price. `isTopicClosed()`'s lowercase comparison
already matched a real `"archived"` value it had only ever guessed at. The
"written against documentation, expect it to be wrong" posture this program
has repeated since P40 held up — not because nothing could go wrong, but
because the code was written defensively enough that what actually showed up
didn't find a gap.

### Two false positives, and they were in the NEW tool, not the old contract

The capture's own field-report flagged two problems. Neither was real:

- **`solicitation_formatted` "missing" on `dibbs/rfqs`.** The contract doc
  already says, in its own words, "List fields: ... Detail adds:
  `solicitation_formatted`, `organization(*)`" — it is a DETAIL-endpoint field
  and its absence from a LIST response is exactly correct. The capture
  script's `DOCUMENTED_FIELDS['dibbs/rfqs']` list included it anyway.
- **`total_contract_price_text` "undocumented" on `dibbs/awards`.** The
  contract doc already lists it, on the very line naming
  `total_contract_price`. The capture script's list for that endpoint simply
  omitted it.

Both are bugs in `diag-tango-contract-capture.ts`'s transcription of the
contract doc into its own `DOCUMENTED_FIELDS` constant — not in the doc, and
not in any mapper. Caught by reading the actual mapper and the actual contract
doc before writing up the operator's summary as findings, rather than
reporting the tool's raw flags as contract facts. Fixed in the same commit as
this entry, with the reasoning left in the script as a comment at each site —
this is the second time in this program a "does the code match the doc"
tripwire itself needed the same scrutiny it was built to apply to something
else.

### What the capture actually found, worth carrying forward

Recorded in full in `dibbs-sbir-rest-contract.md`'s new Findings section;
summarised here:

- `delivery_order_counter` (DIBBS award) arrives as a STRING despite backing an
  INTEGER column. Already coerced correctly by `int()`.
- `total_contract_price` and RFQ `quantity` arrive as native JSON numbers,
  never as the exact-digit strings `decimalString()` was written to protect —
  the provider's own encoder already round-trips them through a float before
  this code sees anything. Nothing downstream can recover a digit already lost
  upstream; not a defect, a limit.
- `sol_download_url` (SBIR cycle) arrives as `""`, never `null`, when absent.
  `str()` already collapses it, which is what stopped this from ever
  rendering as a link to nowhere.
- **`solicitation_status` is two different vocabularies wearing one field
  name.** SBIR topics say `"Open"`; SBIR cycles say `"active"`/`"archived"`.
  `isTopicClosed()` already lowercases before comparing, so it survives both —
  but the shared field name across two endpoints is not a shared value set,
  and the next person to compare a CYCLE's status against `"Closed"` needs to
  know that.
- Neither `topic_id` nor `solicitation_id` is a uuid — confirmed the thing
  every "never reach for `uuid`" comment in this program's SBIR code was
  written to prevent.
- No envelope mismatch on any of the five endpoints. First confirmation of the
  SBIR envelope against a real response.

### What this does not close

Five records per endpoint, one point in time, no detail-endpoint calls, no
value anywhere near DIBBS's NUMERIC(18,4)/(18,2) ceiling. This confirms the
COMMON shape; it is not exhaustive. The captures are preserved as fixtures
(`apps/api/src/external/tango/__fixtures__/real-captures/*-contract-capture-2026-08-09.json` —
a subdirectory, deliberately: the parent `__fixtures__/` has its own rule that every direct
child must be synthetic, for tenant-privacy reasons that do not apply to this public federal
procurement data, and the subdirectory is what keeps that sibling rule's scan from ever seeing
these files)
and run through the real mappers in both mapper spec files, so this observation
is a permanent regression test, not a one-time note in a doc.

## D-69 · 2026-08-08 · A false claim living in an error message nobody ever sees

`funding-opportunities-ci.yml` asserts that each of this program's migrations appears in the
`migrate deploy` log. When one does not, it printed:

> A migration stamped earlier than an already-applied one is never run.

**That is not true of `prisma migrate deploy` (5.22.0)**, and P42's migration is stamped
`20260909010000` while `main` already carries `20261001010000_tango_subaward_intelligence` and
`20261001011000_tango_subaward_reobservation_freshness` — so if the claim held, this phase's tables
would never appear on any environment already past that point.

### Measured, not reasoned about

A disposable Postgres was migrated with `20260909010000_tango_sbir_sttr` REMOVED from the migrations
directory, reaching `20261001011000_tango_subaward_reobservation_freshness`; `to_regclass` confirmed
both `tango_sbir_*` tables absent. The migration was then restored and `migrate deploy` run again:

```
The following migration(s) have been applied:
  └─ 20260909010000_tango_sbir_sttr/

20261001011000_tango_subaward_reobservation_freshness  applied_at=2026-08-09 02:37:21+00
20260909010000_tango_sbir_sttr                         applied_at=2026-08-09 02:37:37+00
```

Both tables were created. `deploy` applies whatever is in the directory and not in the ledger; name
order decides SEQUENCE among pending migrations, not ELIGIBILITY.

### Why a wrong sentence survived here specifically

**It lives on the failure path.** The assertion loop passes on every green run, so the message is
printed approximately never — and an explanation that is never displayed is never questioned. Tests
get run; error text gets read once, when it is written.

Same family as D-62 and D-64, one layer further out: not a claim wider than its evidence, but a
claim with no evidence at all, parked somewhere the repo's own feedback loops cannot reach. Worth
looking for elsewhere — this repo puts a lot of reasoning in strings.

The guard itself is kept, with a corrected message: `migrate deploy` exits 0 on a no-op, so a
migration missing from the directory entirely would still pass unnoticed. Only the explanation was
wrong.

### The list had also stopped covering the newest thing

`20260908010000_tango_dibbs` was absent from that assertion list. P40 shipped a migration and did
not add it, so the one gate that proves a migration actually ran did not cover the most recent one —
and nothing failed, because the gate's coverage is a hand-maintained list rather than a derivation.
Both it and P42's are added.

**A hand-maintained list of things to check silently stops covering the newest thing**, which is the
one most likely to be wrong. The durable fix is deriving the list from the directory; that is a
bigger change than this phase should make to a shared workflow, so it is recorded here rather than
done.

---

## D-72 · 2026-08-09 · A dedicated execution role for sync-jobs, not a wider grant on the shared one

Wiring `TANGO_API_KEY` onto `capiro-dev-api-sync-jobs`'s secrets array (D-26/D-27's live-run
follow-through) hit `AccessDeniedException: secretsmanager:GetSecretValue` on the first dry-run.
Root cause: `capiro-dev-api` (serve), `capiro-dev-api-migrate`, and `capiro-dev-api-sync-jobs` all
resolved the SAME execution role — `Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg`
— so the only way to let sync-jobs read the secret through that role was to grant it to all three.

**That was rejected**, not patched around. `infra/cdk`'s P16 synth test
(`compute-stack.tango.spec.ts`, D-25) exists specifically to prove `TANGO_API_KEY` is absent from
serve/migrate containers; granting the shared EXECUTION role secret-read access does not put the key
in serve's environment, but it does mean the always-on, internet-facing serve process runs under an
IAM identity that CAN read it — the same "once two things share an unqualified credential path,
nothing downstream can tell them apart" reasoning D-03 already applied to Tango data, applied here to
Tango CREDENTIALS.

**Fix:** forked a new role, `capiro-dev-syncjobs-execution-role`
(`arn:aws:iam::967807252336:role/capiro-dev-syncjobs-execution-role`, created 2026-08-09), carrying
the shared role's 17 existing inline policies verbatim plus one new one, `TangoApiKeyRead`, scoped to
exactly the one secret ARN (`arn:aws:secretsmanager:us-east-1:967807252336:secret:tango-c0YGNk`).
`capiro-dev-api-sync-jobs` now resolves this role; `capiro-dev-api` and `capiro-dev-api-migrate`
still resolve the original shared role, unchanged, confirmed by `describe-task-definition` on all
three families after the change. The dry-run then succeeded.

**Why fork rather than parameterize the existing role's policy set:** the shared role backs the
serve API, which is a live, internet-facing target — the LOWEST-risk place to add a secret grant is
nowhere on it. A role that exists for one always-ephemeral, never-internet-facing task family is the
right home for a credential that family alone needs.

**What this forbids:** any future secret intended for sync-only use being added to
`Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg` (the serve/migrate shared role) as a
shortcut. New sync-exclusive credentials belong on `capiro-dev-syncjobs-execution-role`, or on a
further split of it if a future credential needs to be scoped away from sync-jobs' OTHER secrets too.

---

## D-73 · 2026-08-10 · CORRECTION: the verbs were never missing — the deployed `:latest` tag was pointing at an image built from no commit in this repository

First read of this incident (now known wrong, kept here per this log's own no-silent-edit rule):
attempting the full DIBBS walk via the `sync-tango-dibbs` verb failed with "unknown command," and the
container's own printed verb list did not include it — which looked exactly like P40/P42 having
shipped the script but never wired its verb into the entrypoint dispatch chain.

**That diagnosis was wrong.** `apps/api/scripts/entrypoint-dispatcher.inc` on `origin/main` HAS both
verbs — `sync-tango-dibbs` (added `0b6aec0c`, P40 part 3) and `sync-tango-sbir` (added `31cd1dc6`,
P42 part 3) — confirmed by reading `git show origin/main:apps/api/scripts/entrypoint-dispatcher.inc`
directly. Working around the "gap" with a raw `entryPoint`/`command` override then failed a second
way: `ERR_MODULE_NOT_FOUND` for `/app/apps/api/scripts/sync-tango-dibbs.ts` — the file genuinely was
not present in whatever the container was actually running.

**Root cause: the `capiro/dev/api:latest` ECR tag had been repushed** at 2026-08-10T09:17:14-04:00 by
IAM user `capirocli` (the same shared CLI credential this session's AWS operations use), to a digest
tagged with a second string — `5dc9757634c000eb436f3ff0769ab0fe70abfb5f` — shaped like a git commit
SHA but matching **no commit in this repository**: confirmed absent from `origin/main`, and absent
after `git fetch origin` pulled and checked all 720 remote branches. Both `capiro-dev-api-sync-jobs`
revisions 7 and 8 reference the image by the mutable tag `:latest`, not a pinned digest, so both
resolved to this unverifiable build at task-launch time.

**What this is not:** a live incident. `capiro-dev-api`'s (serve) actual running tasks were
independently confirmed on task-definition revision 134, image tag `5c18a427b4dd...` — a real commit
(`5c18a427`, "feat(dashboard): Work Queue + News customization", #893) — deployed 2026-08-09 21:35,
`rolloutState: COMPLETED`, unaffected by the later `:latest` repush. Only NEW, unpinned task launches
against this family (this session's sync-jobs runs; nothing else currently launches this family
unpinned) picked up the unverifiable build.

**Why CloudTrail couldn't settle who pushed it:** `PutImage` for a Docker-protocol `docker push`
records `invokedBy` and `sourceIPAddress` as `ecr.amazonaws.com` regardless of the actual origin
machine — a documented ECR/CloudTrail limitation, not evidence of anything automated. Every push in
this program's history, including this session's own earlier rebuilds, shows the identical pattern
under the identical shared `capirocli` principal. The most likely explanation given the timing (this
session had already rebuilt and pushed this same repository more than once) is a local commit built
and pushed directly to ECR without first being pushed to `origin` — not a third party.

**Fix:** rebuilt from `origin/main`'s verified tip and re-pushed (see the immediately following build
record in this session's history). `capiro-dev-api-sync-jobs` revision 9 pins the sync-jobs image by
**digest**, not `:latest` — specifically so a future unrelated `:latest` repush can never again
silently change what this family's next `run-task` call executes — and, per D-74, uses the ordinary
default entryPoint rather than carrying revision 8's `sh -c` workaround forward: that workaround
addressed a diagnosis this entry retracts, and a correctly-built image needs it for nothing.
Revision 8 is left registered (harmless, unreferenced) rather than deregistered, matching this log's
practice of not deleting evidence of a step that was taken, even a since-superseded one.

**What this forbids:** any task-definition revision for a one-off/manual/diagnostic run referencing
an image by mutable tag when a verified digest is available at registration time. `:latest` is fine
for a long-running SERVICE that goes through a real deployment (which updates the running tasks
explicitly and leaves an ECS deployment record), but not for a `run-task` family whose only
protection against silently running unverified code is what tag its task definition happens to name.

---

## D-74 · 2026-08-10 · The sh -c entryPoint fix from the (retracted) prior diagnosis, kept for a real reason

D-73's first draft is wrong about WHY, but the mechanical fix it made is still correct and still
needed, independent of the `:latest` mystery: ECS `run-task --overrides` does not accept an
`entryPoint` override (`Unknown parameter in overrides.containerOverrides[0]: "entryPoint", must be
one of: name, command, environment, environmentFiles, cpu, memory, memoryReservation,
resourceRequirements` — the CLI's own parameter validation). `sync-tango-dibbs` and `sync-tango-sbir`
ARE correctly wired into `entrypoint-dispatcher.inc` as verbs — but reaching them by verb means
`command: ["sync-tango-dibbs", "--commit", "--full"]`, going through `entrypoint.sh` →
`entrypoint-legacy.sh` → `entrypoint-dispatcher.inc`, all three of which are reachable and correct on
a properly-built image. The entryPoint override was never actually necessary to reach these two
scripts specifically — it was a response to the false diagnosis. Once a correctly-built, digest-pinned
image is used, the plain verb path works and is what P50's disabled EventBridge schedule rules already
assume. Recorded so a future reader of D-73 does not conclude the dispatcher itself needed touching —
it did not, and was never edited.

---

## D-75 · 2026-08-10 · The first real full DIBBS walk stalled 4.5+ hours on an unbounded sleep, root-caused and fixed

With D-73/D-74 resolved, the DIBBS full walk (`--commit --full`, verified digest-pinned image,
`capiro-dev-api-sync-jobs` revision 9) ran clean through the plain verb path — but stalled. Two
independent row-count checks 3 minutes apart, then a third, all read the exact same number
(`tango_dibbs_solicitation = 2520`) and, on the first two, byte-identical "most recent 3 rows." The
task itself stayed `RUNNING`/`CONNECTED` throughout, with zero CloudWatch log output (this script only
logs a per-endpoint summary at completion, never per-page). Total elapsed before it was stopped:
roughly 4.5 hours against a ~50–60 minute estimate.

**Root cause, found by reading the code, not by capturing the live trigger:** `walkEndpoint`'s
proactive throttle —

```ts
if (result.rate?.remaining === 0 && result.rate.resetIn != null) {
  summary.throttleWaits += 1;
  await deps.sleep(result.rate.resetIn * 1000);
}
```

— and `fetchWithRateLimitRetry`'s 429 backoff, both trust the live provider's `resetIn`/`retryAfter`
header value verbatim, multiplied into milliseconds, with **no ceiling**. Every existing test of this
path (`sync-tango-dibbs.spec.ts`, `sync-tango-sbir.spec.ts`) used a synthetic fixture value of `31` or
similar, matching P17's documented "~25 requests per ~31s" window — because no capture before this run
had ever made enough requests in a single burst to trigger a REAL `remaining: 0` response. 2520 rows
is almost exactly 25 pages of 100, the documented threshold — consistent with this being the first
page where a genuine `remaining: 0` response landed, and whatever value the live provider actually
sent, this code slept for it without question.

**The exact real value that triggered it is unrecoverable.** This call path — unlike the original
8-method `TANGO_GATEWAY`/`TangoResilienceService` surface — writes nothing to `tango_api_usage`
(confirmed: no reference to that table or `recordUsage` anywhere under `sync-tango-dibbs*`). Whether
the live `x-ratelimit-reset-in` header sent something in a different unit than seconds, a value meant
for a longer-window quota tier, or something else entirely, no artifact captured it before the task
was stopped. This entry does not claim to know why the value was wrong — only that it demonstrably
was, by its effect.

**Fix:** `MAX_PROVIDER_WAIT_MS = 120_000` in both `sync-tango-dibbs.ts` and `sync-tango-sbir.ts` (SBIR
has the byte-identical pattern at both call sites and has never exercised it live either — fixed
pre-emptively rather than waiting to reproduce the same incident there). Both sleeps are now
`Math.min(reportedSeconds * 1000, MAX_PROVIDER_WAIT_MS)`, and both now log
(`TANGO_DIBBS_SYNC_THROTTLE_WAIT` / `TANGO_DIBBS_SYNC_RATE_LIMIT_RETRY`, and the `SBIR` equivalents)
the endpoint, page, reported value, and actual wait BEFORE sleeping — this run's single biggest
diagnostic gap was that a multi-hour wait produced no evidence of its own existence. Four new tests
(two per script) prove the ceiling holds against an absurdly large reported value on both the
proactive-throttle and the 429-retry path. `funding-opportunities-ci.yml`'s api floor: 88/2782 →
88/2786.

**What this forbids:** any future `deps.sleep(<provider-reported value> * 1000)` call in this program
without a hard ceiling alongside it. A value read from a live response and trusted verbatim into a
sleep duration is exactly the shape of bug this entry exists to name — bounded retries (D-32's breaker
cooldown, this file's own `fetchWithRateLimitRetry` retry COUNT) were already a house pattern; an
unbounded retry DURATION was the gap.
