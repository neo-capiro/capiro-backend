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
- FO CI floor: **81 suites / 2528 tests**. Of the movement from 78/2485, +1 suite
  and +36 tests are P40's; +2 suites and +7 tests arrived from #850.

Do not repair unrelated federal-market baseline failures inside this work unless
they directly block the feature and the causal relationship is proven.

## After part 3

Continue P41–P43 in **fresh context**, using `dibbs-sbir-rest-contract.md` as the
handoff source of truth. P41 is DIBBS matching and UI; P42/P43 are the SBIR/STTR
equivalents, whose endpoints (`/api/sbir/topics/`, `/api/sbir/solicitations/`)
are already transcribed in the same document. Note that SBIR uses `topic_id` and
`solicitation_id` — **not** `uuid` like DIBBS. Do not assume a shared identity
column across the three APIs.
