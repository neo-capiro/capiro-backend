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
