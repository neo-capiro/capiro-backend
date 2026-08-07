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
