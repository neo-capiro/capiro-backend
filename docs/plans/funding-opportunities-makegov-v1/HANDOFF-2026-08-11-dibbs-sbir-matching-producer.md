# DIBBS/SBIR matching — wire the producer that's shipped dark

## STATUS — the scoring logic is built and tested; nothing calls it

P41 ("DIBBS matching and UI") and P43 ("SBIR/STTR matching and UI") are both marked
complete in `completion-matrix.md`, and that's accurate for what they scoped — but
"matching" in those phase names means the SCORING FUNCTION, not a live pipeline:

| File | What it is |
|---|---|
| `apps/api/src/funding-opportunities/dibbs-relevance.ts` | Pure function, real DIBBS relevance scorer. Tested (`dibbs-relevance.spec.ts`). |
| `apps/api/src/funding-opportunities/sbir-relevance.ts` | Pure function, real SBIR relevance scorer. Tested (`sbir-relevance.spec.ts`). |

**Confirmed by grep, not assumed:** nothing outside those two files' own spec files
imports either scorer. `funding-opportunity-inbox.service.ts` mentions
`dibbs-relevance.ts` exactly once, in a comment — not a call. There is no live,
request-time scoring path for DIBBS/SBIR the way SAM.gov/Grants.gov have (see below),
and no producer job. The completion matrix says this directly: "ships DARK — no
producer, no service, no DI wiring, nothing calls it — the same posture P25 took for
`forecast-relevance.ts`."

**Practical consequence: even once ingestion (see the sibling ingestion-resume
handoff) is 100% complete, zero DIBBS/SBIR rows will appear in any client's inbox.**
The catalog tables and the scoring functions exist independently of each other; nothing
currently connects a client to a scored opportunity for either source.

## The pattern to follow — and the one to NOT follow

Two existing producer scripts show the shape this program already uses for exactly this
job:

- `apps/api/scripts/generate-sam-opportunity-candidates.ts`
- `apps/api/scripts/generate-grant-opportunity-candidates.ts`

Read `generate-sam-opportunity-candidates.ts`'s header comment in full before writing
anything — it states the contract precisely: dry-run by default, `--commit`/`--tenant`/
`--client`/`--min-relevance` flags, never overwrites a human decision (any row with a
saved/pursuing/dismissed/won/lost status or `userCreated` is read-only), a
no-longer-qualifying suggestion is marked `staleAt` rather than deleted, and every
`clients`/`client_intel_mapping`/`client_funding_opportunity` access goes through
`withBypass` (FORCE RLS) with an explicit `tenantId` filter alongside it — the bypass
alone does not scope the query.

**Important asymmetry, verified — do not assume SAM/Grants' shape carries over
completely:** that header also says "the read path scores at request time, so a
client's page works whether or not this job has ever run... this producer therefore
exists for persistence and change detection." That live read-time scoring path
**does not exist for DIBBS/SBIR** (confirmed above — nothing calls either relevance
scorer anywhere). So for THIS pair of sources, the producer is not an enhancement on
top of an existing live path — **it is the only path to visibility, period.** This
matches P25's `forecast-relevance.ts` precedent more than it matches SAM/Grants' actual
runtime behavior; follow the SAM/Grants producer's STRUCTURE (flags, RLS idiom,
staleAt-not-delete, human-decision protection) but do not assume a live scoring path
already exists that this producer merely supplements — check
`funding-opportunity-inbox.service.ts`'s actual read path yourself before writing
anything that assumes otherwise, since assumptions here directly determine whether this
is "add a producer" (smaller) or "add a producer AND a live-read integration" (bigger,
and a real product decision about whether DIBBS/SBIR should behave like SAM/Grants at
all — check with Neo before building the second half).

## What the two scorers actually need as input — read before designing the producer

Read `dibbs-relevance.ts` and `sbir-relevance.ts` directly for their exact signatures
and the facts they consume; do not guess from the phase names. Known gaps already
documented in the completion matrix that constrain what this producer can honestly do:

- **DIBBS (P41):** "Three of the plan's five signals are DORMANT for structural
  reasons and are declared rather than faked — no client NSN/part store, no PSC/NAICS
  column on the DIBBS side, no buyer-history store." Prior-CAGE-award history is the
  only signal that can independently qualify an item. **Award rows can never be
  pursued by construction** — the award renderer has no action slot; do not build a
  producer path that would create a pursuable `client_funding_opportunity` row from an
  award. A part/NSN mismatch is a first-class gap field
  (`dibbsPartProfileGap`), not a low score — preserve that distinction if the producer
  persists it.
- **SBIR (P43):** eligibility is a constant `needs_review` with a reason — there is no
  real eligibility determination to persist as anything stronger. Phase (I/II/Direct-to-
  Phase-II) is not published by the source at all (`sbirPhaseGap`) — don't invent one.
  `program` (SBIR vs STTR) lives on the parent CYCLE, not the topic; a producer that
  processes topics without their cycle will get this wrong exactly the way the web
  card's own decision log (P43 part 2) already had to correct for.

## Where this needs a decision, not just code

Before wiring this, get an explicit answer to at least these, and record whichever
answer you get in a new decision-log entry (next number after D-77) — don't infer
either silently:

1. **Producer-only, or producer + live read-time scoring** (see the asymmetry above)?
2. **Schedule cadence.** `infra/cdk/lib/ingestion-schedule.ts` ships DIBBS/SBIR sync
   schedules `enabled: false` already (P50 is separately blocked on the Compute stack
   drift — do not touch that stack to enable them). A matching producer would need its
   OWN schedule decision, independent of P50, and should almost certainly not run more
   often than the ingestion itself can realistically complete, given D-76/D-77's
   account-wide rate-limit findings — a producer scoring against a still-13%-ingested
   DIBBS catalog will just under-recommend, not error, but it's worth being deliberate
   about rather than accidental.
3. **Min-relevance floor and default scope**, mirroring `--min-relevance=25` and the
   `--tenant`/`--client` flags on the SAM producer — these are product calls, not
   engineering defaults to invent silently.

## Acceptance

- New producer script(s) exist, dry-run by default, tested with a fake-double harness
  (no live Tango call — the scorer already takes normalized DB rows as input, not raw
  provider responses, so this doesn't need network access to test).
- A real `--commit` run against the ingested data (however much of it exists at the
  time) creates `client_funding_opportunity` rows visible in the inbox for at least one
  real client with a plausible match.
- The three structural gaps above (award-not-pursuable, part/NSN gap field, SBIR
  phase/program gaps) are preserved as first-class facts in whatever the producer
  writes, not collapsed into a plain low score or silently dropped.
- A decision-log entry records the producer-only vs. producer+live-path decision and
  the schedule cadence actually chosen.
