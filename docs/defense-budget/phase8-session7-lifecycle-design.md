# Phase 8 Session 7 — Annual Defense Budget Cycle Controller + Lifecycle Watcher

**Workstream J. Control-plane/lifecycle automation. Dark.**

Session 7 exists to answer one question: can Capiro operate FY28, FY29 and later
cycles without an engineer hand-building a manifest, manually noticing that an
official source was published, and manually starting ingestion?

It adds no HTTP route, no schedule, no production ownership and no GPU.

---

## 1. What "no engineer" actually requires

Four things, each of which is a separate failure mode:

| Requirement | Mechanism |
|---|---|
| A fiscal year nobody has seen must create itself | Versioned expected-source templates + a rolling horizon driven by the clock |
| A newly published source must be noticed | Per-adapter discovery on a seasonal cadence |
| The same bytes must never be processed twice | SHA-256 content identity with a unique `(expected source, bytes)` observation key |
| A source we are unsure about must not advance anything | Fail-closed classification, enforced by the database, not by convention |

## 2. Cycle identity

Identity is `(fiscalYear, authorityTrack)` — never a global `currentFiscalYear`.
FY27 appropriations, FY28 authorization and an FY24 supplemental are all live at
once.

```
authorityTrack = request | authorization | appropriations | alternative_funding | execution
```

`defense_budget_cycle` is UNIQUE on `(fiscal_year, authority_track)`. That single
constraint is what makes "a newer authorization mark must never overwrite an
appropriations position" structural rather than aspirational: the two tracks are
different rows and cannot address one another.

Every `LifecycleStage` maps to exactly one track (`STAGE_TRACK`), and
`assertStageBelongsToTrack` refuses a cross-track write.

## 3. Automatic bootstrap

`DEFENSE_BUDGET_CYCLE_TEMPLATE_V1` describes which official source **families**
are expected, on which track, at which stage, roughly when, and whether absence
is normal. It contains:

- **no URLs** — discovery rules live in the adapter registry, so a committee can
  reorganise its website without changing canonical cycle semantics;
- **no amounts** — an expected source that is never filed is `not_filed`.

`bootstrapFiscalYearCycle({ fiscalYear })` instantiates all five tracks and the
full expected-source set for **any** year. Measured: FY2028 produces 5 cycles and
82 expected sources, with no bespoke manifest.

`bootstrapRollingHorizon({ nowIso })` keeps prior/current/upcoming populated from
the clock alone. `bootstrapCycleFromFirstDiscovery` covers the other direction:
a first authoritative source for an unseen FY creates that year's cycles.

## 4. Missing is never zero

`expectedSourceFundingPosition(state)` has **no numeric branch**. An unpublished
expected source returns `{ known: false, reason: <state> }`; even a *published*
source returns `{ known: 'source_published', reason: 'requires_governed_ingestion' }`,
because dollars come only from evidence-bound Session 6 ingestion.

Reinforced at three levels:

1. the function cannot return a number;
2. no Session 7 table has a monetary column (asserted against
   `information_schema` in the rehearsal — measured 0);
3. the public DTO exposes `knownFundingPosition: null`, not `0`.

An optional family past its window becomes `not_filed`; a required one becomes
`review_required` so a human looks at it.

## 5. Content identity: bytes, not validators

**`ETag` and `Last-Modified` are bandwidth optimisations. The SHA-256 of the
retrieved bytes is the authoritative content identity.**

This is not a stylistic preference. GovInfo serves `Last-Modified` but **no
`ETag`** on its PDF packages — verified against live packages while building this
session. A validator-first design would be blind on the most important sources.

Seven revision cases, all resolved from bytes first:

| Case | Outcome | New version | Queues ingestion |
|---|---|---|---|
| First sighting | `first_discovery` | yes | yes |
| Same URL, same bytes | `unchanged` | no | no |
| Same URL, changed bytes | `changed` | yes | yes |
| New URL, same bytes | `replacement_url` | no | **no** |
| Publisher version advanced | `superseding_version` | yes | yes |
| Publisher version regressed | `changed` | yes | no |
| Withdrawn / retrieval failed | `withdrawn` / `blocked` | no | no |

`replacement_url` matters for cost: relocated bytes must not re-charge a parser.

## 6. Classification is fail-closed

`classifyLifecycleSource` returns `accept` or `review`. There is no third option.
Real cases it has to get right, each taken from a live GovInfo document:

- **`CRPT-118hrpt125`** (HASC report) — states "NATIONAL DEFENSE AUTHORIZATION
  ACT FOR FISCAL YEAR 2024". Clean accept on the authorization track.
- **`CRPT-118hrpt121`** (HAC-D report) — states **no "fiscal year" phrase at
  all**, only "DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024". The fiscal year
  has to come from the appropriations-bill wording.
- **`CRPT-118srpt81`** (SAC-D report) — "for the fiscal year ending September 30,
  2024".
- **`PLAW-118publ47`** — "FURTHER CONSOLIDATED APPROPRIATIONS ACT, 2024", whose
  own text says "DIVISION A-- NOTE: Department of Defense Appropriations Act,
  2024". Accepted onto appropriations because the law proves its own division.
- **`PLAW-118publ42`** — "Consolidated Appropriations Act, 2024": a real FY2024
  omnibus carrying MilCon-VA, Agriculture, Commerce-Justice-Science,
  Energy-Water, Interior and Transportation-HUD, and **no defence division**.
  Right fiscal year, right vehicle class, wrong subject → **review**.

Ambiguity is enforced downward, not merely returned:

- the observation row is written with `classified_authority_track` and
  `classified_stage` **NULL** (DB CHECK), so "review" cannot masquerade as
  "accepted";
- `review_required` rows must carry a reason (DB CHECK);
- a `review_required` observation **cannot be enqueued** — and an already-queued
  observation **cannot be pushed back into review**. Both are enforced by a
  composite foreign key `(observation_id, observation_state)` with
  `ON UPDATE CASCADE` plus a queueable CHECK, so an application that lies about
  the state fails the FK instead of slipping past the CHECK.

### Deferred corroboration

Metadata alone never advances a stage; the classification is corroborated against
the document's own text. But GovInfo `BUDGET-*` packages and every
comptroller/service exhibit are **PDF-only** — and GovInfo answers a missing
`.htm` rendition with **HTTP 200 and a "Page Not Found" body**, which a naive
fetcher would feed to the classifier as document text.

Extracting text from those PDFs is the deterministic parser's job, and the
watcher must not run the pipeline it exists to queue. So corroboration is
**deferred**, not failed: the classification routes the document, the outcome is
flagged `corroborationDeferred`, and Phase 2 verification — which no provider
output can bypass — remains the gate on the facts. Omitting the excerpt is *not*
the same as declaring it unavailable, so the lenient path cannot be reached by
accident.

## 7. Idempotency and concurrency

| Guarantee | Enforced by |
|---|---|
| Two runs seeing the same source create one observation | UNIQUE `(expected_source_id, content_sha256)` |
| A changed source queues exactly one job | UNIQUE `(observation_id, job_kind)` |
| Concurrent workers cannot double-enqueue | same unique key + `ON CONFLICT DO NOTHING` |
| Two live workers cannot run one adapter | single-owner lease in one atomic statement |
| A crashed worker's adapter is resumable | lease expiry |
| Unchanged bytes cost nothing | `queuesIngestion: false` on `unchanged`/`replacement_url` |
| A run cannot queue more than it observed | CHECK `queued_count <= changed_count` |

## 8. Supersession, never deletion

A superseded observation is marked (`observation_state = 'superseded'`,
`superseded_by_observation_id` set) and keeps its original bytes. The job role has
**SELECT/INSERT/UPDATE and no DELETE** on every control-plane table, so a
superseded version, a failed run and a withdrawn source all stay auditable.

A correction recomputes only the corrected stage and later stages **on the same
track and fiscal year** (`recomputeScopeForCorrection`). Earlier stages and the
other track are returned explicitly as untouched.

## 9. Signals carry no dollars

A signal says the official position at stage X changed relative to stage Y, with
source evidence on both sides. Meri/CRM/Strategies decide the workflow.

Three layers refuse money: `assertLifecycleSignalCarriesNoDollars` walks the
payload at any depth; the signal table has no amount column; and a DB CHECK
refuses any funding-amount key in `payload_jsonb` at any nesting depth.

## 10. Alternative funding

`routeAlternativeFundingDiscovery` routes supplemental / emergency supplemental /
reconciliation / CR / rescission / transfer / reprogramming into the governed
Session 6 path, on the `alternative_funding` track — never as an annual PE stage.

Discovery states that a vehicle of that type exists and classifies it. It cannot
create provisions, allocations, PE dollars or capability dollars; the route
object carries `fabricatesDollars: false` and no amount field exists to populate.

## 11. GPU independence

Under the accepted Session 5 negative provider decision, routing is disabled and
there is no persistent endpoint. Discovery and classification are CPU/network
work:

- `assertWatcherRunnableWithoutGpu` runs before anything else in every run and
  throws on a declared GPU dependency, non-zero capacity, or non-disabled
  routing;
- every registered adapter declares `requiresGpu: false`, and a DB CHECK pins
  `defense_budget_watcher_adapter.requires_gpu = FALSE` — a row cannot even be
  inserted or updated to claim otherwise;
- the provider-routing environment is read in `defense-domain`, not
  `defense-api`, because the Session 3 boundary forbids the HTTP service from
  naming a GPU provider at all.

## 12. Scope boundary, stated plainly

The discovery adapter Session 7 ships is **manifest-driven**. Live crawling of
each publisher's index page or API is dark-deployment infrastructure work, not
control-plane logic.

What Session 7 proves is the part that can go wrong silently: fingerprinting,
revision detection, classification, supersession, idempotency, concurrency and
queueing. Swapping the manifest adapter for a live crawler changes where
candidates come from and nothing about those decisions — and the manifest adapter
already enforces the rule a live crawler must obey, refusing any URL that is not
on the requesting adapter's own official host.

## 13. What Session 7 does not do

No HTTP route (the Session 3 surface stays frozen at 49 routes). No schedule and
no EventBridge watcher. No production schedule ownership. No snapshot promotion
or activation. No production data or AWS mutation. No NVIDIA experimentation,
endpoint or spend. No change to the deterministic parser default.
