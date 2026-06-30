# MeriV2 — Agent Handoff / Kickoff Prompt

> Hand this entire file to the implementing agent. It is self-contained. It supersedes
> `2026-06-29-meriv2-overnight-agent-prompt.md`.

---

## 0. Mission

You are implementing **MeriV2**, the consolidated Meri command architecture for Capiro. Two
documents govern your work; read BOTH in full before writing any code:

1. **Architecture spec (the *what* and *why*):**
   `docs/plans/2026-06-29-meri-consolidated-command-architecture-plan.md`
2. **Technical implementation plan (the *how*, *in what order*, *which files*, *done-when*):**
   `docs/plans/2026-06-30-meriv2-technical-implementation-plan.md`

The implementation plan is authoritative for build order and for the corrected current-state facts.
Its **§1 (Reconciliation)** lists five places where the architecture spec's *current-state* claims
are stale or self-contradictory — **trust §1 over the architecture spec on current state.** In
particular:

- There **already is** an orchestrator (`apps/api/src/meri/`); Phase 0 is *extract-and-share*, not
  greenfield. It already exports `MeriToolsService`.
- Congress / Federal Register / USAspending / LDA / FARA / hearings **are already ingested**
  (architecture §7.1 is right; §1.2's "mostly NOT ingested" is wrong). Build only the §7.2 gap jobs.
- A per-tenant **feature-flag system already exists** (`MeriFeatureFlagsService` +
  `common/tenant-flags.ts`) — reuse it, add `meriv2.*` keys default OFF; do not build a new one.
- Votes/floor/rules/eCFR/CBO/JCT/FPDS are **fully greenfield** (no partial code, despite the spec's
  "partial rollcall code exists").
- There is **no PR-time CI gate** today — you must create one (`ci-pr.yml` + `meriv2-evals.yml`).

Your definition of done is the numbered success criteria **SC0.1 … SC5.9**, reproduced with
verification steps in the implementation plan's §9 traceability matrix. Implement to those.

## 1. Repository & environment

- Repo root: `C:\Users\neoma\capiro-meri` (branch `main`). Monorepo (pnpm + turbo):
  `apps/{api,web,workspace,clio-sandbox}`, `packages/shared`. New code lands in
  `packages/meriv2-core` and `apps/meriv2-orchestrator` (and, in Phase 5, a Live Hearing worker app).
- Shell is git-bash (MSYS) on Windows. Use POSIX syntax for read-only commands. **When writing
  files use NATIVE Windows paths** (`C:\Users\neoma\capiro-meri\...`); MSYS `/c/...` write paths
  create git-invisible orphans.
- Package manager `pnpm`. Verify with `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`,
  `pnpm run build`. DB: `pnpm run db:up`, `pnpm run db:migrate`. New apps/packages are
  auto-discovered (`pnpm-workspace.yaml` + `turbo.json`) — no manifest edits beyond their own
  `package.json`.
- Work on a dedicated branch (`git checkout -b meriv2/phaseN-<topic>`). Commit in small, logical,
  well-described increments. **Never push to `main`; never open an auto-merging PR.**

## 2. Scope & ordering (strict)

Do phases **in order**; finish a phase's success criteria before the next. Within a phase, do the
`P{phase}-T{n}` tasks in order. The implementation plan gives every task its files, interfaces,
dependencies, and done-when.

- **Phase 0 — spine (critical path, 100% before anything else):** `@capiro/meriv2-core` +
  `apps/meriv2-orchestrator` (`/meri-api/*`, cloned from `apps/workspace`) + reuse feature flags
  (add `meriv2.*` OFF) + dormant proxy in both surfaces + migrate `get_client_context` end-to-end +
  parity harness + first-class Claim/Evidence + Compliance stores (additive) + standardize the
  ingestion concurrency guard + scoping-parity test + CI gates. → SC0.1–SC0.7.
- **Phase 1 — alert/KG consolidation:** one alert taxonomy; relocate KG into the Intelligence Center
  shell (mostly UI — models already exist); dedup'd freshness layer. → SC1.1–SC1.4.
- **Phase 2 — gap capabilities + paired sources** (each module + its `sync-*` job together, Appendix
  Z): Vote/Whip/Office → Calendar/Floor → Regulatory (eCFR/OIRA/Unified Agenda) → Compliance precheck
  engine → CBO/JCT fiscal. → SC2.1–SC2.5.
- **Phase 3 — command center:** unified Issue object, planner/workbench, campaign objects + claim-
  backed packets, action-oriented monitoring inbox. → SC3.1–SC3.3.
- **Phase 4 — reliability:** full eval suite + CI thresholds, zero cross-client leakage, artifact-
  review feedback loop. → SC4.1–SC4.4.
- **Phase 5 — Live Hearing (FINAL, GATED):** only after Phases 0, 1, 4 are tagged complete. New
  worker service + Deepgram streaming + `LiveHearingSession`/`TranscriptSegment` + Live Hearing Room
  UI + extraction reusing Phase-0 tools + transcript crypto mirroring debriefs + feeding the Phase-1
  loop. → SC5.1–SC5.9.

If running unattended, a realistic target is **Phase 0 fully complete, then Phase 2 sources +
capabilities as far as you get.** Do not skip ahead to Phase 5.

## 3. HARD GUARDRAILS — do NOT cross unattended (log as `NEEDS-APPROVAL`)

1. **AUTH** — import/call `@capiro/shared` + `apps/api` tenant-mw (`TenantContextMiddleware`) and
   `ClerkService`; never reimplement, relax, or fake identity (no synthetic
   `clerkUserId=pending:<id>`). Clerk v2 `o.{id,slg,rol}` stays source of truth.
2. **EMAIL** — `send_email`/`reply_email` route through the existing MS Graph OAuth path; the
   compliance precheck may gate them but must not bypass OAuth.
3. **CONFIDENTIAL CONTENT / CRYPTO** — debriefs/notes/transcripts stay AES-256-GCM via the existing
   pattern (`apps/api/src/common/secret-crypto.ts`, `engagement/meeting-notes-crypto.service.ts`);
   extracted intel flows to the tenant-members-only KG, never embedded raw. **No new scheme.**
4. **NO LIVE CUTOVER** — all `meriv2.*` flags ship OFF; existing `api`/`web`/`workspace` surfaces
   stay byte-for-byte behaviorally unchanged (SC0.2). A human flips the first tenant.
5. **DATABASE** — additive migrations only (new tables/columns); no ALTER/DROP on existing tables
   without approval; run against the LOCAL dev DB only.
6. **DEPLOY** — you MAY build/deploy the net-new `apps/meriv2-orchestrator` to `capiro-dev`; you may
   NOT redeploy/modify `api`/`web`/`workspace`. If you deploy, PROVE it (SC0.1: running-task
   imageDigest == ECR `:latest` == merge SHA; health 200) and record the values.
7. **DESTRUCTIVE SHELL** — no `rm -rf`, no heredoc/`python -c` file rewrites, no
   `git reset --hard`. Edit via file-edit tools; undo accidents with `git restore`.

If a task genuinely requires crossing a guardrail, STOP that thread, log `NEEDS-APPROVAL` in the
decision log, and continue with other independent work.

## 4. Decision logging (required)

Maintain `docs/plans/2026-06-30-meriv2-DECISIONS.md`. For each non-trivial judgment call append:
context / options considered / decision / rationale / reversibility / tag (`DECISION | ASSUMPTION |
NEEDS-APPROVAL | DEVIATION-FROM-PLAN`). Use your own judgment freely for implementation details,
naming, file layout, and library choices (prefer what the repo already uses) — just log it.

## 5. Quality bar (no shortcuts)

- Full TypeScript types; no `any`, no `@ts-ignore`. Unit tests for every new module; integration
  test wherever a boundary is crossed.
- `typecheck` + `lint` + `test` + `build` must ALL pass before any phase is "done." Run them; read
  failures; fix; re-run. Never report done on red.
- Match existing conventions: study `apps/workspace` + `packages/shared` (service/package shape) and
  a `runWithSyncRun`-based job like `apps/api/scripts/sync-congress.ts` (ingestion shape). Use the
  cloning recipes in the plan's Appendix Y (services) and Appendix Z (sync jobs).
- No TODO/FIXME in shipped paths. Deferrals go in the report as follow-ups, not silent stubs.

## 6. Verification discipline

After each phase, run the full verification suite and capture output. For the orchestrator, capture
the health 200 and the digest triple (SC0.1). For scoping (SC0.7) run the `(user,tenant)` diff test
and capture the result. For parity (SC0.3) run the harness and capture the diff summary. For CI gates
(SC0.6) capture the seeded-regression red build and the post-fix green. Paste these into the report
as EVIDENCE, not claims. If you cannot verify something, say so and name the concrete blocker; never
fabricate output.

## 7. Final report (write LAST → `docs/plans/2026-06-30-meriv2-REPORT.md`)

1. **TL;DR** — what got done, which phase reached, overall red/green.
2. **Live components touched** — every deployed/running thing the operator can poke: name,
   endpoint/how to reach it, state, exactly how to test. Explicitly confirm `api`/`web`/`workspace`
   were NOT behaviorally changed and all `meriv2.*` flags are OFF.
3. **Morning smoke test** — the one flag flip to enable MeriV2 for the internal test tenant, and how
   to roll back (flag OFF) in < 5s.
4. **Success-criteria status** — table of SC0.1…SCx.y, each PASS / FAIL / N-A with evidence link.
5. **Verification evidence** — pasted typecheck/lint/test/build, health 200 + digest triple, parity
   diff, scoping diff, CI red→green.
6. **Decisions** — link the decision log; inline every `NEEDS-APPROVAL` and `DEVIATION-FROM-PLAN`.
7. **Blockers & follow-ups** — what you couldn't finish and why; anything awaiting CTO approval
   (auth/email/crypto/live-cutover); the Live Hearing workstream if not reached.
8. **Branch & commits** — branch name, commit list, how to review the diff.

## 8. Operating rules

- Be autonomous: make the best-judgment call, log it, keep going. Don't stop to ask.
- Prefer finishing Phase 0 completely and correctly over touching many phases shallowly.
- If a hard blocker stops ALL progress (local DB won't start, a guardrail blocks the only path), log
  it, switch to the next independent workstream, document it for the report.
- This is production-bound code for the CTO's flagship platform. Conserve nothing on quality.

Begin by reading both plan docs in full (especially implementation-plan §1 and §2), then
`git checkout -b meriv2/phase0`, then start at P0-T1.
