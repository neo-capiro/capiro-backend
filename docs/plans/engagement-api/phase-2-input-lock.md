# Phase 2 — Input Lock

**Micro-session:** 2.0 — Lock prerequisites and source inputs
**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-2-dark-fargate`
**Base SHA:** `47902517c7dd64a408a87cef57323812407c29c8`
**`origin/main` at lock time:** `f8505002234c716472d1cbbd547462150f4aa683` (branch 0 behind, 146 ahead)
**Date:** 2026-08-06

---

## Scope

Micro-session 2.0 proves Phase 0 and Phase 1 are accepted and freezes the exact
inputs Phase 2 will be executed against.

It changes no application code, no infrastructure code, and no product UI. It
creates no migration, mutates no AWS resource, pushes no image, and creates no
listener rule. This document is the only committed artifact.

---

## 1. Prerequisite acceptance references

### Phase 0 — baseline and no-regression contract

| Field | Value |
|---|---|
| Accepted SHA | `68102d6453ec893100fbc314b2b40cca442ca168` |
| Branch | `agent/engagement-api-phase-0-baseline` |
| Pull request | **none** |
| Merged to `main` | **no** |
| Verifier | `pnpm verify:engagement-phase-0` |
| Contract | `docs/plans/engagement-api/phase-0-baseline-contract.md` |

**Recorded fact.** Phase 0 has no pull request and is not present in `main`. Its
commits are ancestors of the Phase 1 branch and therefore ship inside draft PR
**#755**. Phase 0 acceptance is evidenced by its verifier passing as the first
stage of the Phase 1 closeout, not by a merge. Do not search for a Phase 0 PR.

Do not confuse this with PR **#587** (`feat(engagement): Phase 0 — trust boundary
and external-send integrity`), which is unrelated earlier Engagement work with a
colliding "Phase 0" name.

### Phase 1 — local second runtime

| Field | Value |
|---|---|
| Accepted SHA | `b5de4d0954025483a46413d7a46eeaeb1d1d1345` |
| Head SHA (Phase 2 base) | `47902517c7dd64a408a87cef57323812407c29c8` |
| Branch | `agent/engagement-api-phase-1-local-runtime` |
| Pull request | **#755** (open, draft) |
| Acceptance marker | `ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE` |
| Original evidence | `.artifacts/engagement-phase1-b5de4d0954025483a46413d7a46eeaeb1d1d1345/` |

The head SHA adds only `docs/plans/engagement-api/phase-1-handoff.md` on top of
the accepted SHA (166 insertions, 106 deletions, one file). Phase 2 branches from
the head SHA so the handoff travels with the work.

Phase 1 ends at a draft PR by plan line 11 and §25. **Merge is Phase 10.**

> **Local-ref warning.** The local ref `agent/engagement-api-phase-1-local-runtime`
> in the `capiro-p11` worktree is stale at `0bbb7553` (21 behind, 0 ahead).
> `origin/agent/engagement-api-phase-1-local-runtime` is the correct
> `47902517`. Resolve the Phase 1 head from `origin`, never from the local ref.

---

## 2. Locked source inputs

Frozen by SHA-256 for the duration of Phase 2. These files live outside the
repository and are **not** committed. The prototype in particular must never
enter the repository or any container image.

| Input | SHA-256 | Bytes |
|---|---|---|
| `Outreach V3 (standalone).html` | `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453` | 873843 |
| `engagement-api-outreach-v3-master-context.md` | `fc681d3e046276a6faf49f5fb3c1e95bc1b8c7ba1373876320075958d072e2a8` | 32281 |
| `phase-2-engagement-api-dark-fargate-executable-plan.md` | `384b9c6cb889e09f105f0ab9f040bd20b9259e45cd84db1df8e28d0812dd48ba` | 53317 |
| `phase-2-engagement-api-dark-fargate-ui-aware-micro-sessions.md` | `b4df14017bc8b70effa2d768ded3cdaf04e2bf426e1bca01544c5d080f8d3539` | 47183 |

Source directory at lock time: `C:/Users/neoma/Downloads/`.

Hashes were computed twice by independent methods (`sha256sum` and a Node
`crypto` pass) and agree.

The fourth entry — the micro-session plan being executed — is locked in addition
to the three the plan requires, so a mid-phase edit to the plan itself is
detectable.

### Downstream consumers

Micro-session 2.1 must be invoked with:

```text
OUTREACH_V3_PROTOTYPE_PATH=C:/Users/neoma/Downloads/Outreach V3 (standalone).html
EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256=84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
```

Micro-sessions 2.3 and 2.6 carry the prototype hash into the service task as
nonsecret release metadata (`OUTREACH_V3_PROTOTYPE_SHA256`,
`OUTREACH_V3_UI_CONTRACT_SHA256`). These are provenance and observability fields
only. **They do not enable any UI.**

---

## 3. Prerequisite verification results

Executed on `agent/engagement-api-phase-2-dark-fargate` at
`47902517c7dd64a408a87cef57323812407c29c8` with a clean working tree.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm --filter @capiro/api exec prisma generate` | pass — Prisma Client v5.22.0 |
| `pnpm verify:engagement-phase-0` | **pass** — 110 routes, 46 external importers, 23 side-effect registry entries, 5 process loops, 0 unregistered |
| `pnpm verify:engagement-phase-1` | **pass** — `ENGAGEMENT_PHASE1_DB_FREE_COMPLETE`; 27 API suites; 180 web files / 1580 web tests |
| `pnpm verify:engagement-phase-1:local --sha 47902517…` | **pass** — `ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE` |
| `pnpm turbo run typecheck` | **fail — pre-existing on `main`, see §6** |

Evidence: `.artifacts/engagement-phase2-inputs/logs/` (uncommitted).

### Phase 1 local acceptance — gates measured at the Phase 2 base SHA

Verified by reading the evidence files, not console output.

Evidence directory:
`.artifacts/engagement-phase1-47902517c7dd64a408a87cef57323812407c29c8/`

| Gate | Value |
|---|---|
| `sha` / `actualHeadSha` | both `47902517…` — matches the Phase 2 base |
| `browserProofPerformed` | `true` |
| `browserResponsesVerified` | `true` |
| `realSeededReadParity` | `true` |
| `strictBackgroundContainment` | `true` |
| Read parity | 33 of 33 routes passed |
| External-action denials | 36 registry entries, 36 route probes, all passed |
| Browser surfaces | 4, all `fullyLoaded`, no error boundary |
| `everySurfaceCalledMainApi` | `true` |
| `previewHeaderRequests` | `[]` |
| `previewRoutingEnabled` | `false` |
| `shadowRequests` | `[]` |
| `externalBusinessProviderAction` | `false` |

Background containment was re-proved in a fresh strict process, which logged
every loop disabled by runtime policy: `notetaker-reconcile`,
`outreach-job-worker`, `engagement-sync-scheduler`, `outreach-send-intent-worker`,
and the AI credential advisory — each
`disabled by runtime policy (service=engagement-api owner=disabled)`.

---

## 4. Required confirmations

| Confirmation | Result | Proof |
|---|---|---|
| No pending migration required by Phase 1 | **pass** | Full migration history applies cleanly to a disposable PostgreSQL database via `prisma migrate deploy`. Phase 2 creates no migration. |
| Phase 1 image builds for Linux ARM64 | **pass** | `architecture: arm64`, `os: linux`, user `capiro` (non-root), `cmd: ["serve"]`, port `4500/tcp` exposed |
| Image refuses migration commands | **pass** | `migrateExit: 64` and `unknownExit: 64` — serve-only entrypoint |
| Current web remains main-API only | **pass** | static guard + dynamic browser evidence, below |

ARM64 artifact digests recorded at this SHA:

```text
manifestDigest  sha256:84400c40ffcc424bc43ef3f595c8194397a442d9f490f706e51b09413f17f779
configDigest    sha256:56b98a2c9db8c94b39b65f14fffb34eaa0fc816841e366301013f2ca5ed5efa1
```

These are **local build** digests. They are not an ECR digest and must not be
used to pin a deployment. Micro-session 2.10 resolves the real digest from ECR
after an authorized push.

### Current-web boundary

Two independent proofs.

**Static.** `assertNoWebPreviewRouting()` in
`apps/api/scripts/verify-engagement-phase1-runtime.ts` walks every
`.ts/.tsx/.js/.jsx/.mjs/.cjs` file in `apps/web/src` and fails if any contains
`VITE_ENGAGEMENT_API_URL`, `X-Capiro-Engagement-Preview`,
`http://127.0.0.1:4500`, or `http://localhost:4500`. It passed.

An independent repository-wide grep confirms `X-Capiro-Engagement-Preview`
appears **only** in verification code — the Phase 1 runtime verifier and the
browser-parity harness that asserts the web does not send it — and never in
`apps/web/src`.

**Dynamic.** Across 1504 observed browser requests over four surfaces, 37 reached
Engagement API routes; every one went to the main API on port 4000.
`previewHeaderRequests` and `shadowRequests` are both empty.

Phase 2 must keep this true. Micro-session 2.13 owns promoting this into the
`pnpm verify:engagement-phase-2` current-web no-preview-header guard.

---

## 5. Recorded UI-layout difference

The master context and the prototype disagree about the Outreach V3 conversation
layout. Both are recorded; neither is changed.

| Source | Layout |
|---|---|
| `engagement-api-outreach-v3-master-context.md` §10 | Permanent **left conversation pane** beside a right-side contextual work surface; chat never disappears; no full-screen drawers |
| `Outreach V3 (standalone).html` | Single **workbench** + **bottom-docked conversation bar** + **expandable conversation history overlay**; mobile stacks conversation-first |

### Precedence decision

**The prototype wins for later Outreach V3 UI implementation.**

Per micro-session plan §2, visual and interaction behavior resolves in this order:

```text
1. Attached Outreach V3 prototype
2. Approved later product-owner correction
3. Master context where the prototype is silent
```

The master context remains authoritative for service extraction, migration
sequencing, security, tenant isolation, side-effect ownership, generation and
send safety, and no-autonomous-send behavior. The prototype has **no** authority
over any of those. Where the two conflict on backend architecture or safety, the
accepted Phase 0/1 contracts win, then the full Phase 2 plan, then the master
context, then the prototype.

**Phase 2 does not resolve this difference and must not modify production UI.**
The bottom-docked conversation bar is a visual contract owned by Phase 6. If Neo
later changes the target, that correction supersedes the prototype.

---

## 6. Known limitation — repository-wide typecheck fails on `main`

`pnpm turbo run typecheck` fails. **This is a pre-existing repository condition,
not a Phase 1 or Phase 2 regression.**

- 17 of 18 turbo tasks succeed. The failing task is `@capiro/api#typecheck`.
- Four `TS6059` errors, all in `apps/api/src/defense-budget/**` spec files that
  import helpers from `apps/api/scripts/`, violating `rootDir: apps/api/src`:
  - `contracts/validator-cli-regressions.spec.ts` (2 errors)
  - `non-rdte/non-rdte-artifact-map-proof-regressions.spec.ts`
  - `verification/verification-cycle-report-r83.spec.ts`

### Proof it is pre-existing

- The four failing spec files and `apps/api/tsconfig.json` are **byte-identical**
  to `origin/main`.
- The `typecheck` script in `apps/api/package.json` is **byte-identical** to
  `origin/main`; the Phase 1 diff only appends engagement scripts.
- Running `tsc --noEmit` in `apps/api` on a clean checkout at `origin/main`
  (`f8505002`) reproduces the same four errors. Evidence:
  `.artifacts/engagement-phase2-inputs/logs/typecheck-origin-main-baseline.log`.

### Why Phase 1 still passed

`apps/api/scripts/verify-engagement-phase1-runtime.ts:171` documents this
explicitly:

> The complete monorepo typecheck may contain unrelated main-branch failures;
> Phase 1 gates the production API and web type surfaces it can affect.

Phase 1 therefore gates `tsc -p tsconfig.build.json --noEmit` — the production
surface, which excludes specs — plus the full web typecheck. Both pass.

### Consequence for Phase 2

Phase 2 touches none of `apps/api/src/defense-budget/**`. Fixing the `rootDir`
violation is outside micro-session 2.0's allowed changes and belongs to the
defense-budget workstream.

**Micro-session 2.13 must not put a bare `pnpm turbo run typecheck` inside
`pnpm verify:engagement-phase-2`.** It would fail CI for reasons unrelated to
this phase. Gate the production surface, as Phase 1 does.

---

## 7. Negative controls

| Control | Expected | Result |
|---|---|---|
| NC-2.0-A — flip one hex character of the recorded prototype checksum | input verifier fails | **pass** — reported checksum drift, exit 1, `ENGAGEMENT_PHASE2_INPUT_LOCK_FAILED` |
| NC-2.0-B — remove the Phase 1 acceptance reference | gate fails | **pass** — `lock.phase1 acceptance reference is missing; Phase 2 may not begin`, exit 1 |

Both controls mutated a **copy** of the lock manifest; the recorded values were
never modified. The positive control passes with
`ENGAGEMENT_PHASE2_INPUT_LOCK_VERIFIED`, confirming the controls fail for the
intended reason rather than because the verifier fails on everything.

The verifier fails closed: a missing field, a missing file, a changed byte, an
absent acceptance reference, or a Phase 1 SHA that is not an ancestor of the base
SHA are each errors, never skips.

### Recorded drift — verifier location

Micro-session 2.0's allowed-changes list is exactly this document plus
uncommitted evidence, so the input verifier `verify-phase-2-inputs.mjs` lives in
the **uncommitted** evidence directory rather than `scripts/`. The values it
checks are carried forward by this committed document, and micro-session 2.1
independently enforces the prototype hash through
`EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256`.

**Recommendation for micro-session 2.13:** promote the verifier into `scripts/`
and add it to `pnpm verify:engagement-phase-2` so input drift is caught in CI.

---

## 8. Carry-forward constraints

Restated so later micro-sessions need not re-derive them.

- Do not merge. Phase 1 ends at a draft PR; merge is Phase 10.
- Do not implement Outreach V3 production UI in Phase 2.
- Do not add LangGraph, workflow tables, or Campaign Spec persistence.
- Do not create a database migration.
- Do not route ordinary users to `engagement-api`.
- Do not move Recall, OAuth callbacks, mailbox sync, workers, generation, or sends.
- Keep `engagement-api` in the exact fail-closed shadow posture.
- Do not modify or deploy the historical frozen Compute stack.
- Do not change DNS, certificates, the generic `/api/*` rule, or the current web runtime.
- Do not deploy, push an image, or mutate AWS without separate explicit
  authorization for that exact action. **Authorization is nontransitive.**

### Environment constraint

**No AWS credentials are available in this environment.** Every run logs
`Could not load credentials from any providers` (the Directory service degrades
to a lazy-load warning, which is expected and non-fatal). Micro-sessions 2.15
through 2.20 cannot execute here. Micro-sessions 2.1 through 2.14 are all
code-and-contract work and are unaffected.

---

## 9. Known limitations carried forward

1. **Mislabeled evidence field.** `local-runner-summary.json` hardcodes
   `clerkAuthentication: "existing_session_cookie"`. This run used a minted Clerk
   sign-in token. The truth is in `browser-parity.json`
   (`browserAuthMethod: "signin_token"`). Reproduced at this SHA. Fixing it
   invalidates the evidence bundle and requires a full re-run — owner's call.
2. **Local image digests are not deployment digests.** See §4.
3. **The input verifier is uncommitted.** See §7.

---

## 10. Non-obvious operational notes

Carried forward from the Phase 1 handoff; they will otherwise be rediscovered the
hard way.

1. `main` moves faster than a full acceptance run. Both stage 1 and stage 2 refuse
   a branch behind `main`, and merging invalidates stage 1 evidence, so a merge
   forces a full re-run. Consider requesting a freeze of roughly 40 minutes.
2. Never edit the tree mid-run. Stage 3 requires a clean checkout and pins the
   exact head.
3. Clerk session tokens live about 60 seconds. Any handed-off token expires; the
   API bearer token is minted immediately before the parity stage.
4. `apps/api/scripts/` and runner scripts are excluded from every tsconfig —
   transpiled, never typechecked. This is the root cause of §6.
5. Browser auth uses a minted Clerk sign-in token redeemed via
   `signIn.create({strategy:'ticket'})`. The cookie in the credentials file is a
   24-character non-JWT and cannot authenticate.
6. The local acceptance requires `ENGAGEMENT_PHASE1_SKIP_BROWSER` to be **unset**
   (the credentials file sets it to `1`) and both
   `ENGAGEMENT_PHASE1_ORGLESS_BROWSER=1` and
   `ENGAGEMENT_PHASE1_BROWSER_AUTH=signin_token` to be exported.
7. Treat any "passing" check that could pass without comparing anything as
   suspect. Two prior false-green classes were a skip-browser path that fabricated
   its own success values, and read parity passing vacuously on an expired token
   because two matching 401s satisfied the comparator. Both are now guarded.

### Route correction for micro-session 2.2

The **web** route `/engagement/integrations` **does not exist**. `EngagementPage`
accepts only `meetings`, `outreach`, and `reports`; `overview` maps to
`meetings`, and anything else falls back to Meetings. Integrations is a Settings
page at `/settings/integrations` (`apps/web/src/App.tsx:361`).

The master context §3.2 still lists `/engagement/integrations` as a product
route. **That line is stale.** The Phase 1 browser harness has already been
corrected and probes `/settings/integrations`; the four measured surfaces are
`/engagement/meetings`, `/engagement/outreach`, `/engagement/reports`, and
`/settings/integrations`, each with a distinct `renderedPathname`.

Do not conflate the web route with the API route. The **API** routes
`/api/engagement/integrations` and
`/api/engagement/integrations/{google,microsoft}/capabilities` **do exist** and
are called from the Settings page. Micro-session 2.2 must map the Integrations
capability to the Settings web route and to those API routes.

---

## 11. Next micro-session

**2.1 — Extract the prototype interaction contract.**

It must parse the bundled HTML without executing prototype JavaScript, store no
font or base64 asset bytes and no volatile timestamp, store no real secret, token,
or recipient data, and produce a deterministic manifest recording the
bottom-docked conversation layout from §5.

Expected outputs per the plan:

```text
scripts/outreach-v3-prototype-contract.mjs
scripts/outreach-v3-prototype-contract.spec.mjs
docs/contracts/outreach-v3-prototype-contract-v1.md
apps/api/src/engagement/__fixtures__/outreach-v3-prototype-state-manifest.v1.json
```
