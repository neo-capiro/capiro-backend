# Office → Program matcher — spec

**Status:** proposed (2026-07-04). **Owner:** program→people coverage.
**One-liner:** populate `program_office_program_link` (currently **0 rows**) so the
already-deployed role-chain read path lights up the ~3,370 person→office roles.

---

## 1. Why

The People & office tab reaches a PE two ways (`acquisition-personnel-read.service.ts`):
1. legacy `pePrimary`/`peSecondary` (direct), and
2. role chain: `PersonRole.officeId → [accepted ProgramOfficeProgramLink] → Program → [accepted PeProgramMatch] → peCode`.

The role chain is deployed but **inert**: `program_office_program_link` has 0 rows, so
the ~3,370 accepted person→**office** roles reach no PE. `roleChainReach` = 2 people /
5 PEs (only the handful of direct person→**program** roles connect). Meanwhile the data
to infer office→program links exists — nothing writes it. `import-dow-orgs` is the only
writer and it only accepts a link when a DoW program's *owner exactly matches an
imported office*, but DoW owners are **people**, so it emits ~0 office links.

**This is the single highest-leverage lever for People-tab coverage** and it just became
viable: the 2026-07-04 auto-approve set `pePrimary` on 1,109 people, so the
person-co-occurrence signal (below) now has enough grounded links to bootstrap from.

Goal: emit accepted/candidate `ProgramOfficeProgramLink` rows, deterministically and
review-gated, so `roleChainReach.peopleViaChain` jumps from 2 into the hundreds without
per-person confirmation.

---

## 2. Data model change

`program_office_program_link` today: `officeId, programId, relation('manages'|'executes'|'supports'), sourceUrl, confidence, reviewStatus`.
It lacks provenance (unlike `pe_program_match`, which has `evidence`/`evidenceTier`/`matchBasis`).

**Migration** (`add_office_program_link_provenance`): add nullable
- `evidence Json @default("[]")` — array of `{ kind, detail, count?, sourceUrl? }`.
- `evidenceTier String?` — highest tier that produced the link (see §4).
- `matchBasis String?` — human-readable ("7 of 9 office people map to program X").
- `derivedBy String?` — cohort tag e.g. `derive-office-program-links@v1` for reversible re-derive.

No column drops; `@@unique([officeId, programId])` stays. `import-dow-orgs`' existing
`upsert` keeps working (new cols nullable).

---

## 3. Signals (all deterministic, no LLM)

Per candidate `(office O, program P)` pair, gather evidence from:

- **A — person co-occurrence (strongest, newly viable).** Count distinct people with a
  non-quarantined `PersonRole(officeId=O)` who ALSO resolve to `P` via
  `pePrimary → accepted PeProgramMatch(peCode) → programId=P`. High count / high share of
  O's PE-mapped people ⇒ O manages P. Reuses the 1,109 confirmed links.
- **B — owner-derived (zero-inference).** For each program P, take its DoW/PEO
  owner-people (the person→program roles `import-dow-orgs`/`sync-peo-rosters` already
  create, `programId=P`) and map each owner to their office O via `PersonRole(officeId)`.
  Owner ∈ O ⇒ O manages P. This converts the existing person-owner signal into office links.
- **C — `programOfRecord` aggregation.** For O's people, normalize
  `AcquisitionPersonnel.programOfRecord` and match to `ProgramAlias.aliasNormalized` → P;
  tally. (PEO rosters + DoW carry programOfRecord.)
- **D — name/alias overlap.** Normalize `O.name` to distinctive tokens (reuse the
  `pe-program-matcher` normalizer + stopword list) and match against `ProgramAlias`
  (exact `aliasNormalized`, then `pg_trgm` similarity). Exact distinctive-token
  containment is strong; trigram-only is candidate. Write matched office names back as
  `ProgramAlias(aliasType='office_usage')` for future runs.

Signal B is the cleanest; A is the highest-recall now; C/D fill offices whose people
lack `pePrimary`.

---

## 4. Scoring & acceptance (mirror the repo's conservative matcher philosophy)

Evidence tiers (highest wins), with the resulting default status:

| Tier | Rule | Default |
|---|---|---|
| `owner_in_office` | ≥1 program owner-person (roles from DoW/PEO) is in O | **accepted** |
| `people_majority` | ≥3 of O's people AND ≥50% of O's PE-mapped people resolve to P (signal A) | **accepted** |
| `office_name_exact` | a distinctive P alias token is contained in O.name (signal D exact) | **accepted** |
| `por_majority` | ≥3 people in O carry programOfRecord→P (signal C) | **candidate** |
| `people_minority` | 1–2 people co-occur (signal A) | **candidate** |
| `office_name_trgm` | trigram similarity ≥0.6, no exact (signal D) | **candidate** |

- **Never auto-accept a purely fuzzy (trigram) match** — matches `pe-person-matcher` /
  `sam-opportunity-matcher` rules.
- `confidence` = tier-weighted (0.95 owner, 0.9 majority/exact, 0.6–0.75 candidate).
- `relation`: default `manages`; `executes` when the office is a `pm`/`pae` type,
  `supports` for `contracting_office`. (Refine later; `manages` is safe.)
- Multiple tiers on the same pair → take the max, union evidence, keep the strongest status.

---

## 5. Algorithm (one verb, idempotent)

`scripts/derive-office-program-links.ts` (dry-run default, `--commit`, `--min-conf`):
1. Load offices, programs+aliases, accepted PeProgramMatch, person→office roles,
   person→program roles, people (pePrimary, programOfRecord). All global tables.
2. Build the `(O,P) → evidence[]` map by running signals A–D in memory (no per-pair queries).
3. For each pair, compute tier/status/confidence/matchBasis (§4).
4. **Upsert** `program_office_program_link` on `(officeId, programId)`:
   - skip rows whose `reviewStatus` was set by a human (never clobber review decisions —
     detect via `derivedBy IS NULL` or a `reviewed` marker),
   - else write with `derivedBy='derive-office-program-links@v1'`.
   Delete-and-rewrite only this cohort (regenerable), like the other derive verbs.
5. Log counts by tier + status; print top-N samples for spot review.

Register the verb in `entrypoint.sh` (a `case` arm — the container rejects unregistered
verbs; the `*)` help string is stale, so add the arm regardless).

---

## 6. Ordering / DAG

Run **after** person↔PE confirmations (pePrimary must be populated for signal A) and
after PeProgramMatch is current. Slot into the derive DAG:
`derive-budget-actions → derive-relationships → (person↔PE confirm/auto-approve) →
derive-office-program-links → derive-intelligence-cache`.
No read-path change needed — the deployed role chain consumes accepted links immediately.

---

## 7. Verification (definition of done)

- Dry-run prints links-by-tier; committed run writes only its `derivedBy` cohort.
- Re-run `diag-graph-coverage`: `officeProgramLinks` 0 → N; **`roleChainReach.peopleViaChain`
  jumps from 2 into the hundreds** and `pesWithChainPeople` well above 5. This is the
  success metric.
- Spot-check 10 accepted links against reality (office name + program + the people that
  drove it) — expect ≥90% correct for `owner_in_office` / `people_majority` / `office_name_exact`.
- Idempotent: a second run with no data change is a no-op (same cohort rewritten).
- No human-reviewed link altered.

---

## 8. Risks / honest limits

- **Signal A is bootstrapped by pePrimary**, which came from the auto-approve — so link
  quality inherits candidate-match quality. Keep A gated to *accepted* PeProgramMatch only.
- Offices whose people have **no** pePrimary and no programOfRecord get links only from
  name overlap (D) — lower recall. Acceptable; those surface as candidates.
- `office_name_exact` can over-fire on generic office names — the stopword list
  (from `pe-program-matcher`) must strip generic acquisition words; keep exact match to
  *distinctive* tokens/acronyms only.
- One office legitimately manages many programs (a PEO) — expected; no per-office cap,
  but log offices with >20 links for review.
- This does **not** replace the person↔PE candidate queue; it's the complementary
  office-level path. Both feed the same tab.

---

## 9. Effort

~1 script + 1 small migration + entrypoint arm + a targeted spec test on the scoring
(pure function). ~½–1 day. Ships as one PR; run is a one-off ECS task, then re-diag.
Reversible (delete the `derive-office-program-links@v1` cohort).
