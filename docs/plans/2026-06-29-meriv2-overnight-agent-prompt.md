# MeriV2 — Overnight Autonomous Implementation Prompt

> Hand this entire file to the implementing agent. It is self-contained.

---

## 0. Mission

You are implementing **MeriV2**, the consolidated Meri command architecture for Capiro. The
authoritative spec is:

`docs/plans/2026-06-29-meri-consolidated-command-architecture-plan.md`

Read that file IN FULL before writing any code. It defines the architecture, the deployment
model (Option B: standalone Fargate service + per-tenant feature-flag cutover), the tenant+user
scoping inheritance requirement, the data-source/ingestion inventory, the phasing, and the
numbered success criteria (SC0.1 … SC5.9). Implement to those success criteria — they are your
definition of done.

You are running overnight, unattended. The operator (Neo, CTO) is asleep and will test in the
morning. Work continuously and autonomously until the scoped work is complete or you hit a hard
blocker. **No shortcuts, no stubs left behind, highest engineering standard.** Every piece of
code you write must compile, pass lint/typecheck, and have tests.

## 1. Repository & environment

- Repo root: `C:\Users\neoma\capiro-meri` (branch `main`). Monorepo: `apps/{api,web,workspace,
  clio-sandbox}`, `packages/shared`.
- Shell is git-bash (MSYS) on Windows. Use POSIX syntax. **When writing files, use NATIVE
  Windows paths** (`C:\Users\neoma\capiro-meri\...`); MSYS `/c/Users/...` paths mangle file
  writes and create git-invisible orphans. Read-only shell commands may use `/c/...`.
- Package manager: `pnpm`. Verification commands: `pnpm run typecheck`, `pnpm run lint`,
  `pnpm run test`, `pnpm run build`. DB: `pnpm run db:up` / `db:migrate` (local Postgres).
- Do all work on a dedicated branch: `git checkout -b meriv2/phase0-overnight`. Commit in small,
  logical, well-described increments. Do NOT push to `main`. Do NOT open a PR that auto-merges.

## 2. Scope for tonight (in strict order — finish each before the next)

Implement the plan **in phase order**, completing each phase's success criteria before moving
on. Realistic overnight target is **Phase 0 fully done to SC0.1–SC0.7, then Phase 2 pipelines +
capabilities as far as you get**. Do not skip ahead to Live Hearing (Phase 5).

1. **Phase 0 — the spine (highest priority, must be 100% complete):**
   - `packages/meriv2-core` (`@capiro/meriv2-core`): intent router, typed tool registry,
     scoping wrapper, grounding/claim-map assembly. Pure, fully typed, unit-tested.
   - `apps/meriv2-orchestrator`: thin HTTP service hosting the package at `/meri-api/*`,
     modeled EXACTLY on the `apps/workspace` service template (Dockerfile, ECR workflow,
     Fargate task def, ALB wiring). Health endpoint returning 200.
   - **Tenant + user scoping inherited from current Meri** (SC0.7): import `@capiro/shared`
     tenant-mw / Clerk middleware — do NOT reimplement auth. Every tool handler receives and
     filters on `{tenant_id, user_id, roles, org}`. Build the (user,tenant) diff test that
     proves MeriV2 returns the identical row set current Meri returns for the same user.
   - Per-tenant + per-surface feature flags, **default OFF**. Wire the proxy path in both
     surfaces but leave it dormant behind the flag.
   - Parity harness: same input → both paths → diff. N≥20 requests per surface.
   - Promote Claim/Evidence + Compliance/Audit to first-class Prisma stores (ADDITIVE migrations
     only — no ALTER/DROP on existing columns).
   - Wire cross-client-leakage + grounding evals as CI gates.
2. **Phase 2 — capabilities + their paired ingestion pipelines** (per §7.2/§7.3): build each
   new `sync-*` job on the existing `SyncRun`/`ScheduledJob` construct with the cron cadence
   specified in the plan. Pair each capability with its data source (a capability without its
   source is a stub — build both or neither). Prioritize: votes/floor/rules → regulatory
   (eCFR/Reginfo) → fiscal (CBO/JCT).

If you finish Phase 0 + Phase 2 with time remaining, continue into Phase 1 (alert/KG
consolidation) and Phase 3 (command center). **DO NOT implement Phase 5 (Live Hearing /
Deepgram) under ANY circumstances tonight** — not even if every other phase is complete and you
have hours to spare. The operator is handling Live Hearing as a separate workstream AFTER this
one, with himself awake. It depends on the full spine and touches the confidential-content
crypto guardrail, so it is explicitly out of scope. If you finish everything else, stop and
write the morning report; do not start Live Hearing. List it as the operator's next workstream
in the report's follow-ups.

## 3. HARD GUARDRAILS — do NOT cross these unattended (log as morning blockers instead)

These touch protected systems. You may NOT modify them tonight without explicit human approval.
If your work genuinely requires one, STOP that thread, log it in the decision log as
`NEEDS-APPROVAL`, and continue with other work.

1. **AUTH**: Do not modify Clerk integration, tenant-mw, JWT validation, or session logic. You
   may IMPORT and CALL them; you may not change them. Never fabricate `clerkUserId=pending:<id>`.
2. **EMAIL**: Do not modify the MS Graph OAuth send/reply path. Tool handlers may be drafted but
   must route through the existing email service unchanged.
3. **CONFIDENTIAL CONTENT / CRYPTO**: Do not alter the AES-GCM `meeting_debriefs` encryption or
   invent a new scheme. (Live Hearing crypto is Phase 5 — out of scope tonight anyway.)
4. **NO LIVE CUTOVER**: All feature flags ship **OFF**. Do NOT flip any tenant onto MeriV2.
   Existing Meri surfaces must remain byte-for-byte behaviorally unchanged (SC0.2). The morning
   test is the operator flipping the flag for ONE internal tenant — not you.
5. **DESTRUCTIVE SHELL**: No `rm -rf`, no `python -c`/heredoc file rewrites, no
   `git reset --hard`. Edit files via your file-edit tools. Undo any accidental git pollution
   with `git restore`, never `reset --hard`.
6. **DATABASE**: Migrations are ADDITIVE ONLY (new tables/columns). No destructive migrations on
   existing tables. Run migrations against the LOCAL dev DB only; do not touch prod/staging DBs.
7. **DEPLOY**: You MAY build and deploy `apps/meriv2-orchestrator` to the `capiro-dev`
   environment (it is net-new and behind no live traffic). You may NOT redeploy or modify the
   existing `api`, `web`, or `workspace` services. If you deploy the orchestrator, PROVE it:
   running-task imageDigest == ECR `:latest` digest == your merge SHA, and record it.
8. **LIVE HEARING IS OUT OF SCOPE TONIGHT**: Do not implement Phase 5 (Live Hearing / Deepgram
   streaming, `LiveHearingSession`/`TranscriptSegment` models, live room UI, transcript crypto).
   The operator runs that as a separate workstream after this one. Even with time to spare,
   stop and write the report instead.

## 4. Decision logging (required)

Maintain a running log at `docs/plans/2026-06-29-meriv2-overnight-DECISIONS.md`. For every
non-trivial choice you make using your own best judgment, append an entry:

```
### [HH:MM UTC] <short title>
- Context: what forced a decision
- Options considered: A / B / C
- Decision: what you chose
- Rationale: why (cost, risk, consistency with existing patterns)
- Reversibility: easy / moderate / hard to undo
- Tag: DECISION | ASSUMPTION | NEEDS-APPROVAL | DEVIATION-FROM-PLAN
```

Use your own judgment freely for implementation details, naming, file layout, library choices
(prefer what the repo already uses), and ambiguous spec points — just LOG it. Anything tagged
`NEEDS-APPROVAL` or `DEVIATION-FROM-PLAN` must be surfaced prominently in the morning report.

## 5. Quality bar (no shortcuts)

- Every new module: full TypeScript types, no `any` escape hatches, no `@ts-ignore`.
- Every new tool/handler/service: unit tests; integration test where it crosses a boundary.
- `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, `pnpm run build` must ALL pass before
  you consider any phase done. Run them; read failures; fix them; re-run. Do not report "done"
  on red.
- Match existing repo conventions (look at `apps/workspace` and `packages/shared` for the
  service/package template, and the existing `sync-*` jobs for ingestion-job shape).
- No TODO/FIXME left in shipped code paths. If something must be deferred, it goes in the
  morning report as a follow-up, not as a silent stub.
- Idempotent ingestion jobs (`SyncRun --since`, one-instance lock), additive schema, content-
  hash embeddings — follow §7.4 guardrails.

## 6. Verification discipline

After each phase, run the full verification suite and capture the output. For the orchestrator
service, hit the health endpoint and capture the 200. For scoping (SC0.7), run the (user,tenant)
diff test and capture the result. For parity (SC0.3), run the harness and capture the diff
summary. Paste these into the morning report as EVIDENCE — not claims. If you cannot verify
something, say so and explain the concrete blocker; never fabricate output.

## 7. Morning report (write this LAST, to `docs/plans/2026-06-29-meriv2-overnight-REPORT.md`)

Structure it so Neo can test in minutes:

1. **TL;DR**: what got done, what phase you reached, overall red/green.
2. **LIVE COMPONENTS TOUCHED** (the section Neo cares about most): every deployed/running thing
   you changed or created that he can poke in the morning. For each: name, URL/endpoint/how to
   reach it, current state, and EXACTLY how to test it. Explicitly confirm that existing
   `api`/`web`/`workspace` surfaces were NOT behaviorally changed and all cutover flags are OFF.
3. **How to flip the morning smoke test**: the one command/flag to enable MeriV2 for the
   internal test tenant, and how to roll back (flag OFF) in <5s.
4. **Success criteria status**: table of SC0.1–SCx.y, each PASS / FAIL / N-A with evidence link.
5. **Verification evidence**: pasted typecheck/lint/test/build results, health-check 200,
   parity diff, scoping diff.
6. **Decisions**: link to the decision log; inline the `NEEDS-APPROVAL` and
   `DEVIATION-FROM-PLAN` items.
7. **Blockers & follow-ups**: anything you couldn't finish and why; anything awaiting his
   approval (auth/email/crypto/live-cutover).
8. **Branch & commits**: branch name, commit list, how to review the diff.

## 8. Operating rules

- Be autonomous. Do not stop to ask questions — make the best-judgment call, log it, keep going.
- Prefer finishing Phase 0 completely and correctly over touching many phases shallowly.
- If a hard blocker stops ALL forward progress (e.g. local DB won't start, a guardrail blocks the
  only path), log it, switch to the next independent workstream, and document it for the morning.
- Conserve nothing on quality; this is production-bound code for a CTO's flagship platform.
- Final sanity check before you finish: re-read SC0.1–SC0.7 and confirm each is genuinely met
  with evidence, not asserted.

Begin by reading the plan doc in full, then `git checkout -b meriv2/phase0-overnight`, then
start Phase 0.
