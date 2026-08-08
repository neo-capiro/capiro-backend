# P40 part 3 — handoff

Written at the close of the session that shipped P40 parts 1 and 2. Committed to
the repo deliberately: four earlier handoffs in this program exist only on one
machine's local disk, and this program's own history is unrecoverable if that
machine is lost.

**Source of truth for the provider contract is
[`dibbs-sbir-rest-contract.md`](./dibbs-sbir-rest-contract.md).** Read it before
writing a line of the sync. It is transcribed from published documentation and
marks explicitly what is confirmed (field names) and what is not (types, null
semantics, date formats, pagination envelope).

## STATUS — part 3 is BUILT (2026-08-08), and still unverified against the provider

Everything in "What part 3 must deliver" below is now implemented. Read that section as the
specification it was, not as outstanding work. What shipped:

| File | What |
|---|---|
| `apps/api/src/external/tango/tango-dibbs.client.ts` | The REST client for the three DIBBS endpoints. New. |
| `apps/api/scripts/sync-tango-dibbs.ts` | The sync. Dry-run by default. |
| `apps/api/scripts/sync-tango-dibbs.spec.ts` | 27 tests, no Postgres and no network required. |
| `apps/api/scripts/entrypoint-dispatcher.inc` | `sync-tango-dibbs` verb. |
| `apps/api/tsconfig.funding-opportunities.json` | Both new script files registered. |
| `infra/cdk/lib/ingestion-schedule.ts` | `SyncTangoDibbs` + `ReconcileTangoDibbsFull`, **both `enabled: false`**. |
| `.github/workflows/funding-opportunities-ci.yml` | Scope regex, suite list, floors raised to 82/2556. |
| `decision-log.md` | **D-63**, below. |

**No migration was added, no schedule was enabled, and no AWS or deployment change was made.**

### The one thing that changed the design — read D-63

`tango_sync_checkpoint.resource_type` carries a CHECK admitting exactly
`entity, opportunity, notice, forecast, vehicle, vehicle_awardee`. No migration has ever widened it, and
P40's own migration does not either. **A DIBBS checkpoint row is unstorable**, so this is the first sync in
the program that keeps none — the window is derived from the newest issued/posted date already stored.

That is not merely a workaround. DIBBS publishes no `modified_after` filter, only `issue_date_after` /
`issued_date_after` / `posted_date_after`, so **the window is an issue-date window, not a modification
window**: a solicitation amended after issue does not re-enter it, and an incremental run will miss the
amendment while still reporting `complete`. `--full` is the mitigation and the shipped schedule pairs a
daily incremental with a weekly full reconciliation. A schedule that only ever runs the incremental will
drift silently.

### What is still NOT done

- **The live contract-validation step has not run.** Every coercion in the mappers and every assumption in
  the client — including the `results`/`next`/`count` pagination envelope — is still a reading of
  published field names. This remains the real gate.
- **P17's entitlement question is still open — but the probe can now answer it.** See **D-64**: the
  `dibbs` and `sbir_sttr` probes had D-62's error compiled into them, reporting
  `unsupported_by_provider`, with a test pinning it. `dibbs` is now a real read-only probe
  (`listRfqs({ limit: 1 })` through `TangoDibbsClient`); `sbir_sttr` reports `not_attempted` with an
  honest reason until P42/P43 build a client. **The 2026-08-07 capability report's rows for these two
  are superseded and must not be cited** — re-run `diag-tango-capabilities` to answer them.

  A live run now closes two questions at once: entitlement, **and** whether the pagination envelope is
  what the client assumes. A mismatch surfaces as `TangoDibbsEnvelopeError` naming the problem, rather
  than as an empty page.
- The client **throws** rather than returning an empty page when `results` is absent, so a wrong envelope
  fails loudly on the first live run instead of reporting "0 records, complete". Expect that to be the
  first thing the live run tells you, and treat it as a contract update plus a new fixture — never a
  client that accepts both shapes.

## What is already on `main`

| PR | What |
|---|---|
| [#851](https://github.com/neo-capiro/capirov2/pull/851) | D-62 correction — P40–P43 were never blocked on the provider; contract doc added |
| [#852](https://github.com/neo-capiro/capirov2/pull/852) | Schema + migration `20260908010000_tango_dibbs` (two tables) |
| [#853](https://github.com/neo-capiro/capirov2/pull/853) | Mappers + 33 tests + real-Postgres round trip |
| [#854](https://github.com/neo-capiro/capirov2/pull/854) | Structural no-alias-fallback guard (+3 tests) |

All of it is **additive and inert** — no running code reaches any of it. The
migration is **not** applied to `capiro-dev` (it postdates the last migrate run).

## Two decisions that are settled — do not revisit

**1. RFQ and RFP get separate mappers.** They normalize to one table but the
provider spells the same concept differently per endpoint (`issue_date`/
`return_by_date` vs `issued_date`/`closes_date`). Endpoint-specific contracts are
preferred over a permissive mapper: **provider drift must fail visibly rather
than silently normalize into a plausible-looking record.**

Four negative properties are pinned by tests, and all four must survive:

- the RFQ mapper does not recognise RFP-only date keys;
- the RFP mapper does not recognise RFQ-only date keys;
- a missing required provider field produces an explicit null/omission rather
  than falling back to the other endpoint's vocabulary;
- **no mapper uses "first available of these aliases" logic** — enforced
  structurally by a source scan in `tango-dibbs.mapper.spec.ts`, not by
  convention. Aliases are permitted only if the provider *documents* aliases.
  It does not.

That last guard was proven to fire by injecting a real alias into the real
mapper: it failed three tests, not one. Keep it that way — a guard that cannot
fail is theater.

**2. A quantity with no unit is dropped; the solicitation is kept.** Do not
invent `EA` or any other unit — that invents the fact. `reconcileQuantity`
returns the outcome rather than mutating silently, precisely so the sync can
count it.

## What part 3 must deliver

1. **Sync script** — `apps/api/scripts/sync-tango-dibbs.ts` (+ spec). Incremental,
   page-complete.
2. **Dispatcher verb** — `apps/api/scripts/entrypoint-dispatcher.inc`.
3. **Schedule definition present but DISABLED by default** —
   `infra/cdk/lib/ingestion-schedule.ts`.
4. **Dry-run / inspect posture by default.** No writes without an explicit flag,
   matching every other mutating command in this program.
5. **Explicit write/commit posture** where applicable.
6. **Structured run summary**, including:
   - `quantity_dropped_missing_unit` — the count from `reconcileQuantity`. **If
     this is materially nonzero during live validation, treat it as a
     contract-investigation signal, not something to suppress.**
   - endpoint-specific mapping failures (records dropped for no `uuid`, no
     `solicitation`, no `award_number`), counted per endpoint rather than
     pooled — a pooled count cannot tell you which endpoint's contract drifted.
7. **Idempotency / replay tests.** Re-running a page must not duplicate. The
   upsert key is the provider's own `uuid` (`tango_dibbs_id`, unique on both
   tables).
8. **No provider secret in logs, errors, or fixtures.** `tango.errors.ts` already
   redacts `X-API-KEY`, `api_key=`, `"apiKey":` and bearer-style tokens — reuse
   it rather than writing new error handling.
9. **No schedule activation.**
10. **No AWS or deployment change.**

## Hard constraints that do not relax

- **No live provider call from an agent session.**
- **No key passed into an agent session** (plan §4.6).
- **No inferred undocumented types, null semantics, date formats, or pagination
  envelope.** The published docs give field *names*. Everything else in the
  mappers is a conservative reading, and the tests represent *our current
  interpretation*, not proof of live-provider behaviour.
- Note the documented pagination (`page`/`limit`, max 100) **differs** from the
  SDK's `PaginatedResponse<T>` `results` envelope this codebase already models.
  Confirm the real envelope before reusing existing pagination helpers.

## Before production-ready

There must be a **separately authorized live contract-validation step**, in an
appropriate environment, checking the real response shape against the pinned
assumptions in the contract doc and the mappers.

Any mismatch causes a **contract update and a new fixture** — never a permissive
production fallback. Resist the instinct to make the mapper accept both shapes;
that is the same failure the alias guard exists to prevent.

The P17 entitlement gate is also unchanged: endpoints existing says nothing about
whether Capiro's plan is entitled to them. Only a real call with a real key
answers that.

## Baseline hygiene

Judge this phase on **introduced** regressions, not inherited ones. As of the
last merge here:

- api typecheck: **12 pre-existing errors**, none in funding-opportunities code.
  It was 6 until PR #850 (federal-market unification) merged and doubled it.
  **Re-measured 2026-08-08 at `main` d1d7030c (PR #856) and after part 3: still
  exactly 12.** #856's `noImplicitAny` fix was in `apps/web`, so the api count
  never moved, and part 3 introduced none.
- FO CI floor: **now 82 suites / 2558 tests**, raised from 81/2528 by part 3.
  Of the movement from 78/2485 to 81/2528, +1 suite and +36 tests are P40's;
  +2 suites and +7 tests arrived from #850. The 81/2528 -> 82/2558 move is
  **entirely** this work's: +27 in `sync-tango-dibbs.spec.ts`, +1 dispatch row,
  +2 in `tango-capability-probe.service.spec.ts` (D-64). Measured against real
  Postgres 16 on a clean migration replay — 82 passed, 2558 passed, zero
  failures, zero skips.

Note that #856 (the NewsCatcher dashboard) added a 402-line spec under
`src/intelligence/news/`, which does **not** appear in this gate's enumerated
suite list and therefore never touched the floor. The list is explicit for
exactly this reason.

Do not repair unrelated federal-market baseline failures inside this work unless
they directly block the feature and the causal relationship is proven.

## After part 3

Continue P41–P43 in **fresh context**, using `dibbs-sbir-rest-contract.md` as the
handoff source of truth. P41 is DIBBS matching and UI; P42/P43 are the SBIR/STTR
equivalents, whose endpoints (`/api/sbir/topics/`, `/api/sbir/solicitations/`)
are already transcribed in the same document. Note that SBIR uses `topic_id` and
`solicitation_id` — **not** `uuid` like DIBBS. Do not assume a shared identity
column across the three APIs.
