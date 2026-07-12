# Phase 2.5 — Finishing the v3 Zero-Trust Grounding Master Plan — Execution Status

Companion to Ninja's Phase 2.5 plan. Records the audit outcome + what shipped.
As with Phase 2, the plan's "remaining" list was largely already built by the
in-flight v3 effort; this pass closed the genuinely-open items.

## Audit outcome (workflow-verified 2026-07-12) — already shipped, do NOT rebuild

- **Full D1–D11 deterministic taxonomy** registered in `runAuditor`, incl. the
  D3/D5/D8 the plan lists as "missing" (`checkUnitMagnitude`/`checkSponsorExistence`/
  `checkPrimaryVehicleOverclaim`). Unit-tested green. (2.5-2 core ✅)
- **Real LLM skeptic judge** (`createLlmSkepticJudge`, schema-forced, fail-closed) —
  #431. (2.5-3.1 ✅)
- **Wave-1 citation primitives** (`validateFormBCitations`→`sanitizedText`,
  `CitationAnchor`, `FORM_B_CITATION_RE`). (2.5-4 primitives ✅)
- **G2 golden + G3 grounding suites run blocking on every PR** via `ci-pr.yml`;
  G1 mechanism evals blocking via `meriv2-evals.yml`. (2.5-5 PR-time ✅)
- `decisionFor()` computes the correct per-surface `hold`/`repair` already.

## The core finding: `enforce` was inert everywhere

No call site consumed `verdict.decision`. On chat it was a pure no-op; on
outreach/alert-memo/research, `enforce` was byte-for-byte identical to `annotate`
— it prepended an internal "unverified" note and the draft/memo/report **still
shipped**. `decisionFor()` produced the right `hold`, but nothing acted on it, and
`meri_audit_ledger.decision` was write-only.

## What shipped this pass (branch `feat/phase25-deliverable-enforce`)

Ninja decisions taken at kickoff: **deliverables → hold-as-draft (block
send/file)**; **chat → observe-only, documented** (per ADR-2, no buffer-before-
stream latency hit on the busiest surface).

- **2.5-1 real deliverable enforce-handling** — each deliverable surface now
  consumes `verdict.decision === 'hold'` (which `decisionFor()` returns ONLY under
  `enforce` on a blocking surface with a finding — so this is inert under
  shadow/annotate and changes nothing by default):
  - **alert-memo**: a held memo is generated + returned for review (markdown
    carries the Unverified banner) but **NOT auto-filed** to the client's
    Documents (`document: null`, `held: true`).
  - **research**: a held report artifact is persisted with `heldForReview: true`
    metadata + the banner, so it's never presented as a cleared deliverable.
  - **outreach**: a held per-recipient draft returns `status: 'held'`; the wizard's
    `partitionGenerationResults` buckets `'held'` with non-sendable so it can never
    be auto-sent (the send gate for a fresh batch). (web + api)
  - **chat** (both surfaces): documented as deliberately observe-only — `enforce`
    behaves like `shadow` (findings observed, reply unchanged). Not a gap.
  - Tests: alert-memo enforce→held (not filed) + shadow→filed; outreach
    `'held'`→non-sendable partition test; api+web+meriv2-core+orchestrator
    typecheck clean; affected suites green.
- **2.5-2 golden coverage** — added D3/D5/D8 golden fixtures (+ clean
  counter-examples) to `auditor-golden.spec.ts`; fixed the stale
  "HONEST COVERAGE BOUNDARY" docstring (14 passed / 1 todo).
- **2.5-5 nightly gate** — new `grounding-nightly.yml`: scheduled (cron) run of
  the G2 golden + G3 grounding suites as two independently-named jobs (so a later
  pre-roll gate can hang off the golden job by name). Uses forward-slash
  `--testMatch` globs (separator-agnostic; a bare positional path mis-resolves on
  some jest/OS combos).

## Deferred (per ADR-9 / the plan's own sequencing) — NOT done this pass

- **2.5-4 live citation-stripping** (mutating delivered text) — the v3 plan
  explicitly deferred this behind "enforce-post-hoc-first". Primitives exist; no
  live path strips yet. Defer to Phase 4.
- **2.5-3.2/3.3 skeptic live routing** — depends on integrating the claim gate
  into a live generation path (entangled with the deferred Wave-4 ClaimPlan
  pipeline). The judge module is done; nothing invokes it yet. Defer to Phase 4.
- **2.5-5 pre-prod-roll G2 gate** — changes the CI contract (build workflows are
  deliberately test-free today; deploys are manual). Small open decision on where
  it lives (build workflow `needs:` vs a `deploy-dev.sh` pre-roll check).
- **Tier 2** (2.5-6 dependency-graph tables, 2.5-7 more compiler adapters, 2.5-8
  G0 boundary test) — durable architecture; not blocking, Phase 4 territory.
- **district-brief** surface: mirrors alert-memo and runs the auditor, but wasn't
  given the hold treatment this pass (state-legislation twin) — fast-follow.

## The one thing that stays Ninja's call: flipping a tenant to enforce

The handling is built and **inert** — `MERI_AUDITOR_MODE` is `shadow` on both api
and orchestrator task defs, and no tenant is on enforce. Actually flipping a
surface/tenant to `enforce` (which now genuinely holds client-facing deliverables)
is a deliberate canary step that needs Ninja sign-off + a shadow-observation
window first, per the plan's own discipline. Not done here.

## Exit gate — honest status

- **G1** (enforce changes chat output) — intentionally **reframed**: chat stays
  observe-only per ADR-2; enforcement is real on the DELIVERABLE surfaces instead.
- **G2** (full D1–D11 taxonomy, golden-tested) — **MET** (D3/D5/D8 golden added).
- **G3** (skeptic wired) — **PARTIAL**: real judge module done; live routing
  deferred to Phase 4 (entangled with the ClaimPlan pipeline).
- **G4** (citation stripping live) — **DEFERRED** to Phase 4 per ADR-9.
- **G5** (CI gates real) — **advanced**: PR-time G2/G3 already blocking; nightly
  run added + named. Pre-roll gate is the remaining (decision-gated) piece.
