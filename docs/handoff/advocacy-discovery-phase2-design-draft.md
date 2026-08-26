# Advocacy History Phase 2 — Unified Public Discovery: Design Draft (NOT YET BUILT)

Status: draft for review, produced against origin/main @ bba106d51db69f577ec0ebe57d36f0e2ac772.
This is a design artifact only — no functional code has been written yet.
Per the capiro-advocacy-history skill's sequencing rule, source-breadth work
ships as its OWN closeout PR, separate from any structural change, and this
codebase's own history (session 6's "pending-finding to Matter assignment"
question) shows forking product decisions get explicitly resolved by the
user BEFORE code, not guessed. This doc exists to get those decisions made
cheaply, before any implementation time is spent.

## 1. What already exists (Phase 0 audit, this session)

See the per-source table delivered in-chat. Key facts driving this design:

- LDA is the ONLY source with a client resolver today, and it's a
  human-curated list (`selected_lda_ids`), backed by a REAL fuzzy-match
  suggestion mechanism already built: `client-profile-fill-workflow.service.ts`
  uses Postgres `pg_trgm` `similarity()`/`word_similarity()` against
  `lda_client.name` vs the Capiro client's name, scores confidence
  `0.5 + similarity*0.48` (capped 0.99), and surfaces `suggested` vs
  `imported` identities for a human to confirm before any LDA filing is
  ever pulled into a Fill run.
- Every other public source (Regulations.gov, Federal Register, hearings,
  testimony, FARA) has a `linkX` method that ATTACHES a record a human
  already found by ID — none of them can be searched FOR a client.
- The existing `readLinkSourceOrUnavailable` helper and the
  deterministic-match-or-manual-rationale gate (`linkHearing`'s
  committeeSystemCode-vs-primaryBillId join) are the two reusable
  primitives already proven in this codebase for exactly this class of
  problem (safe read + auto-confirm only on unambiguous evidence).
- Cursor infra (`client_profile_fill_source_cursor`, merge-on-write
  watermark_jsonb) already generalizes to any new source key.

## 2. Proposed shape (matches the product objective's requested pipeline)

A new **read-only, no-side-effect-until-reviewed** service,
`AdvocacyDiscoveryService`, that the `advocacy_history` Fill task calls
IN ADDITION to (not instead of) `gatherAdvocacyHistory`'s existing three
sub-pipelines. It does NOT write client_advocacy_record rows directly —
it emits the exact same `FillFinding` shape (`kind: 'advocacy_record'`,
`status: 'pending'`) the existing pipelines already use, so the entire
downstream review/apply/Matter-assignment/lock machinery is reused
unchanged (per "do not rebuild the review-gated canonical-write model").

```
for each registered discovery adapter (one per source type):
  1. resolveClientMatch(client) -> candidate identifiers + confidence
     (reuses the pg_trgm pattern above for name-keyed sources; PE/bill
     code lookups for sources already tied to a client's known PEs/bills)
  2. if no match above MIN_AUTO_CONFIDENCE: skip silently (no finding,
     no noise) UNLESS a human has previously confirmed an identifier for
     this client+source (persisted, see §4) — then always search
  3. search(matchedIdentifiers, sinceWatermark) -> raw source rows
  4. normalize each row -> AdvocacyDiscoveryCandidate
  5. addFinding(...) using the EXISTING generic Fill finding pipeline
```

### AdvocacyDiscoveryCandidate → FillFinding mapping

`proposedValue` gets the exact same field shape `gatherAdvocacyHistory`
already writes (`externalKey`, `recordType`, `title`, `summary`,
`activityDate`, `sourceType`, `sourceId`, `sourceUrl`, `evidenceClass`,
`confidence`, `metadata`) — the interface in the mission brief maps onto
this directly, it does not require a new finding kind or a new endpoint.
`clientMatch.confidence` becomes `proposedValue.confidence`;
`clientMatch.method`/`identifiers` go into `metadata.clientMatch` for
audit/review-card display (frontend gap already flagged as open in the
skill: "Resolve ambiguity" review-card richness, §23).

## 3. Per-source adapter plan (ordered by effort/value, NOT yet built)

| Source | Client-match approach (proposed) | New ingestion needed? | Effort |
|---|---|---|---|
| FARA | Reuse pg_trgm name-similarity against `fara_registration.registrantName` (same pattern as LDA) | No — table already synced | Small |
| Regulations.gov | Match on client name / known officer names inside comment submitter fields (`RegulatoryDocket` — need to check comment-submitter schema depth) | No — table already synced | Medium (submitter field richness unknown, needs a second audit pass) |
| Federal Register | Same submitter-name approach if the model carries commenter fields; otherwise this source may only ever support manual linking | No | Medium/Unknown — needs the same depth-audit as Reg.gov before committing to effort |
| Congressional hearings/testimony | Match `CommitteeHearing.witnesses[]` (bare names) against known client officers/lobbyists (already collected elsewhere in the client record) | No | Small (name match), but ceiling is low — testimony has no organization/URL to backfill (per skill's confirmed granularity gap) |
| CPF | New canonical model + sync job (net-new, per skill: confirmed absent) | YES | Large |
| CDS | New canonical model + sync job (net-new, per skill: confirmed absent) | YES | Large |
| Bills / PE / appropriations | Independent client-level scan (today only rides in via LDA/manual metadata) — would need a "client's known PE codes/bill IDs" registry to search FOR, which partially already exists via `client_pe_relevance` / `client-prepopulation.service.ts` (found this session, not yet fully audited) | Partial — needs one more audit pass on client_pe_relevance before scoping | Medium |

## 4. Open decisions needing an explicit answer before writing code

1. **Auto-confidence threshold for name-matched public sources.** LDA's
   existing pattern treats >=0.5-ish trigram similarity as "suggest, human
   confirms once, then always search." Should FARA/testimony reuse that
   same threshold, or does this product want a HIGHER bar for FARA given
   its more sensitive nature (foreign-principal registrations)?
2. **Confirmed identifiers persistence.** Where does a human's one-time
   "yes, FARA registration X is this client's lobbying firm" confirmation
   live — a new table, or a reuse of the existing LDA-style
   `client_intel_mapping`-adjacent mechanism? (This session found
   `client_intel_mapping` exists but hasn't audited whether it's source-
   agnostic enough to extend vs needing its own table.)
3. **CPF/CDS priority.** These are the only genuinely net-new ingestion
   sources (everything else reuses existing synced tables). Given cost-
   consciousness, is CPF/CDS in scope for THIS closeout, or deferred to a
   later phase given it's Large effort with zero existing scaffolding?
4. **Sequencing per the skill's own rule**: this design proposes ONE
   scoped PR per adapter (FARA first, as smallest lift), never one mega-PR
   bundling all sources — confirm that's still the preferred cadence.
5. **Silent-skip-below-threshold behavior (§2 step 2)**: confirm that a
   below-threshold client match should produce NO finding at all (rather
   than a low-confidence finding a reviewer has to dismiss) — this
   mirrors the existing product spec's "don't collapse two distinct
   events" caution, applied to false-positive client attribution instead
   of false-positive event merging.

## 5. What Phase 1 (the production canary) blocks

None of the above requires Phase 1 to be closed first at the code level —
they're independent slices. But per the mission brief's own ordering and
this repo's standing production-canary policy (canaries mutating real
client data stay dark unless the user personally runs them), Phase 1's
canary is explicitly NOT run in this session. Everything above is safe to
scope/build without it; the ADVOCACY_HISTORY_COMPLETE closeout doc update
mentioned in the mission brief should wait until the user has actually
run and confirmed the canary.
