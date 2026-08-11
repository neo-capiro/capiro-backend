# Web vNext / os.capiro.ai — handover for the next session

**Written:** 2026-08-11 · **Branch:** `agent/web-vnext-figma-impl` · **Deployed:** `928970ce`

## The goal you were handed

Get **Meri (v3 undocked chat), LegiWatch, Dashboard, App Shell, Client Profiles, and
Program Elements** all merged into `main` and shipped, all rendering on **os.capiro.ai**
and **not** app.capiro.ai, all matching their mockups or better.

Two of those six are genuinely built. Read §3 before believing any status.

---

## 1. The fact that makes this safe (verify it, then stop worrying)

**Merging every vNext file into `main` will NOT put vNext on app.capiro.ai.**
The surface is chosen per ECS task definition, not per branch:

| Service | `WEB_SURFACE` | Renders |
|---|---|---|
| `capiro-dev-web` → app.capiro.ai | *(unset)* | `<AppShell/>` — canonical/legacy |
| `capiro-dev-web-vnext` → os.capiro.ai | `vnext` | `<VNextApp/>` |

`App.tsx` picks the surface from `resolveWebPresentation(webSurface)`, which reads
`window.__CAPIRO_CONFIG__.webSurface`, which nginx's `entrypoint.sh` writes from the
`WEB_SURFACE` env var at container start.

So: **merge freely to `main`; ship os.capiro.ai by deploying the WebVNext stack.**
The one rule from the runbook — never add `WEB_SURFACE=vnext` to the canonical web task.

Re-verify in one command before you trust this:
```bash
aws ecs describe-task-definition --task-definition capiro-dev-web:72 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`WEB_SURFACE`]'
```

## 2. Where things actually stand

- Branch `agent/web-vnext-figma-impl`, worktree `C:\dev\capiro-vnext-wt`, clean and pushed.
- os.capiro.ai serves `928970ce`, task def `capiro-dev-web-vnext:6`, 1/1 running.
- **Nothing vNext is in `main` yet.** MeriV3 *is* in main; app.capiro.ai runs `744c4b23`
  (2 behind main) which includes MeriV3's UI-parity commits.
- Rollback: `5422d719` / `sha256:9cf355e8…`. Full image history is in
  `docs/runbooks/web-vnext-release-dev.env`.

**Do not trust a handoff doc's claim about what is deployed.** It has been wrong twice.
Read the live task definition's image tag and resolve it to a git SHA yourself.
This session found os.capiro.ai running `d6644a89` from a *different branch*
(`chatgpt/os-vnext-strategies-legiwatch`) that no one had mentioned — deploying as
planned would have silently reverted Strategies and LegiWatch off the live domain.

## 3. What is real vs. what only looks done

The single fastest test — a real design-system implementation imports **no antd**:

```bash
grep -rln "from 'antd'\|@ant-design/icons" apps/web/src/vnext/
```

| Family | Status | Evidence |
|---|---|---|
| **App Shell** | ✅ real | zero antd; built from `722:2502` frames |
| **Dashboard** | ✅ real | zero antd; rebuilt this session against the `760:2641` contract |
| **LegiWatch** | ⚠️ **re-layout, not an implementation** | `VNextLegiWatchPage.tsx` imports antd; embeds canonical `RadarPage` |
| **Strategies** | ⚠️ **re-layout, not an implementation** | 3 files import antd; `/strategies/:id` renders legacy `StrategyEditorPage`; steward/agent routes wrap canonical components in a `GovernanceSurface` shim |
| **Program Elements** | ❌ not started | `pages/program-elements/` is a README placeholder only |
| **Client Profiles** | ❌ not started, **and design source unknown** | see §6 |
| **Meri v3 undocked** | ✅ shipped & verified live | see §5 |

Strategies and LegiWatch came in via the merge from `chatgpt/os-vnext-strategies-legiwatch`.
They render and carry real data, but they are the old UI re-arranged. Neo flagged exactly
this. The merge commit `06a9d936` calls the result "one vNext surface from one Figma
source" — that is accurate for the shell and Dashboard only. Correct it if you touch it.

**Good news for Program Elements:** the seven intelligence visualisations it needs are
already built and design-system-clean in `apps/web/src/vnext/intelligence/`
(FundingTrajectory, FundingBridge, CongressionalPath, EvidenceCoverage, MovementRail,
MovementDistribution, ProgramRelationshipMap), and are already mapped in the manifest.

## 4. Figma: node IDs, and the frames that are actually normative

**`apps/web/src/vnext/figma/manifest.ts` is the node inventory. Use it.** It records
page + frame IDs for appShell, dashboard, programElements, strategies and legiWatch.

**The top-level page list from `get_metadata` with no nodeId is incomplete** — it returns
9 design-system pages and omits every "Canonical App" page (Strategies `842:2502` is real
but unlisted). Never conclude a design doesn't exist from that list.

### Read the family's Handoff frame FIRST — before any code

Each family ships a designer-authored engineering contract. The Dashboard's
(`760:2641`) went unread for two sessions and, when finally opened, **contradicted the
prose brief**: density is three modes not two, module *order* is a persisted preference
nobody had built, and the ship gate (acceptance A–F) lives there rather than in the brief.

| Family | Handoff frame |
|---|---|
| Dashboard | `760:2641` (read; drove this session's rebuild) |
| Program Elements | **`788:2765`** — never read |
| LegiWatch | **`891:2593`** — never read (+ system states `895:2593`) |
| Strategies | check page `842:2502` for the equivalent — never read |

Expect each to carry: a module/content matrix (allowed vs excluded content), a
customization contract, a density contract, a per-file code mapping, a migration
boundary, and acceptance criteria. Treat them as the ship gate.

### Non-negotiable process rule

**Always `get_design_context` on the actual node before writing a line of CSS.**
Never build from `get_metadata` + a screenshot. Phase 1 followed this and needed no
rework; Phase 2 didn't and needed three rounds of fixes plus a full rebuild this session.
Load the `figma-design-to-code` skill first — the tool requires it.

## 5. Meri v3 undocked chat

**This is the latest Meri and it is already done, in `main`, and verified live.**
Commits `c0f8646a` (workspace UI parity) and `13dec063` (pixel-match the mockup).

- Path: launcher → `openMeriWorkspaceWindow()` → `/?meriWindow=1` → `VNextApp` detects
  `isMeriWorkspaceWindow()` → `MeriOverlay` → `MeriWorkspaceWindow`.
- Verified on os.capiro.ai: thread rail, command header, composer with `SCOPE: THREAD`,
  governance line, prompt library, tenant `CAPIRO-INTERNAL`.
- Gate: `features.meriv3Chat` = `MERIV3_ENABLED` **and** tenant slug in
  `MERIV3_CANARY_TENANT_SLUGS` (currently six tenants) **and** per-tenant
  `meriv3.fullChat`. The live API has the first two open.

**The trap:** if any gate is closed, or the popup is blocked, `MeriOverlay` silently
falls back to the **MeriV2 drawer** — the old UI, with no error. If Meri "looks old",
check the gate before assuming the build is stale.

**MeriV2 itself is deliberately frozen.** The canary brief makes it a hard constraint
that `ChatDrawer`'s default path keep rendering exactly as today, because it serves every
non-canary tenant with no visual regression coverage. Do not restyle it without an
explicit decision. Structural v3 changes go behind `variant === 'v3'` or, better, in the
sibling `MeriWorkspaceConversation` component that already exists.

**Design source for the Meri workspace is NOT Figma** — it is
`C:\Users\neoma\Downloads\Meri Chat Workspace.html` (+ `meri-mockup-dom-styles.txt`).
Figma only carries Meri *tokens* (`color/action/meri/*`, `Elevation/Meri`, `shadow/meri`).

## 6. Client Profiles — scope change, and an open question for Neo

Client Profiles was **explicitly out of scope** for this program until Neo put it in scope
in this session's final instruction. Before building:

- **No Client Profiles page exists in `figma/manifest.ts`, and a design-system search
  finds no Client Profile frames.** The design source is unknown — ask Neo where it is.
- Prior art lives on other branches: `agent/capiro-design-system-v3-react`,
  `agent/client-profile-crm-cleanup`, `dev/outreach-client-profile`.
- A recorded lesson applies: *client-profile forked whole-file against main's #892 — v3
  must be re-applied onto the modular components, not merged.* Expect the same
  whole-file-fork problem the shell had this session.

## 7. Code Connect — live, and you must use it

Code Connect is **published and working** (Neo upgraded the Figma plan; it is
Org/Enterprise-gated). Verified this session against `722:2502`.

**What it does for you:** `get_design_context` on a mapped node returns *your real
component* wrapped in `<CodeConnectSnippet>` instead of generic markup. Use the named
component and drop the wrapper. The import path in the snippet may be non-relative or a
URL — search the codebase for the component and use the real one.

Confirmed live mappings (Figma → `apps/web/src/vnext/…`):

| Figma | React |
|---|---|
| Button/Main | `CapiroButton` — components/actions |
| Status/Badge | `CapiroBadge` — components/badges |
| Field/Input | `CapiroInput` — components/fields |
| Choice/Control | `CapiroSelect` — components/fields |
| Table/Row | `CapiroTableRow` — components/tables |
| Shell/Search | `GlobalSearch` — shell/GlobalSearch |
| Shell/MeriLauncher | `MeriLauncher` — shell/MeriLauncher |
| Shell/ContextChip | `CapiroContextBar` — shell/ContextBar |
| Navigation/Item + Navigation/TopItem | `CapiroNavItem` — shell/Sidebar |
| Mailbox Sync | `MailboxSyncStatus` — shell/MailboxSyncStatus |

Also useful:
- `get_code_connect_map` on a screen node lists every mapped child at once — cheap way to
  see what you can reuse before implementing.
- `get_code_connect_suggestions` / `add_code_connect_map` / `send_code_connect_mappings`
  to **add** mappings. As you build Program Elements and Client Profiles, publish
  mappings for the new components so the next session inherits them.
- Re-map with `send_code_connect_mappings` if components move.
- `FIGMA_REACT_MAPPING_INVENTORY` at the bottom of `figma/manifest.ts` is the
  human-readable companion — keep it in sync.

Known gap: Button/Main is a 30-variant matrix (Standard|Compact × Primary|Secondary|Quiet
× Default|Hover|Focused|Pressed|Disabled) and needs a Focus/Ring effect `CapiroButton`
lacks.

## 8. Release mechanics (all verified this session)

```bash
# 1. build ARM64 (Fargate here is arm64; QEMU on this x86 box, ~20 min warm cache)
docker buildx build --builder pe-ship --platform linux/arm64 \
  -f apps/web/Dockerfile \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:$SHA --push .

# 2. deploy (context lives in docs/runbooks/web-vnext-release-dev.env)
cd infra/cdk && npx cdk deploy --app "ts-node --prefer-ts-exts bin/web-vnext.ts" \
  -c releaseSha=$SHA -c webVnextImageDigest=$DIGEST  # …plus the imported-infra context
```

- **Never `pnpm --filter … -- -c …`** — pnpm forwards `--` literally, cdk silently drops
  every context value and fails with `Missing required CDK context: releaseSha`.
- Run `cdk diff` first. os.capiro.ai and app.capiro.ai **share the `capiro-prod-alb`
  listener**; app.capiro.ai is the listener's *default* action and vNext is a host rule at
  priority 50. **Any diff touching the default action or a rule below 50 is a stop
  condition.** A clean diff touches only WebVNext-owned resources plus a TaskDef replace.
- Pipe the build through `tee`, not `tail` — `| tail` buffers and you get no progress.
- Rollback = redeploy the prior SHA + digest. CloudFormation deregisters the old task-def
  revision, so the retained SHA-tagged ECR image is what makes rollback possible.

## 9. Known gaps and risks

1. **Tablet stage (1024) has never been seen rendering.** The CSS is written from
   `757:2618`/`758:2622` and unit-tested, but the browser window would not resize below
   the desktop breakpoint in this environment. Mobile *was* verified live.
2. `/strategies/:id` and the steward/agent routes are the legacy UI behind a shim.
3. `pnpm --filter @capiro/web visual:vnext:capture` has never produced artifacts
   ("No Lighthouse screenshot data was available"). Screenshot review is manual.
4. Repo-wide GitHub Actions have been `startup_failure` since 2026-07-31 — there is no CI
   signal on any branch. Verify locally; don't blame your branch.
5. `main` carries unapplied Prisma migrations from PE Phase 7. **A web-only WebVNext
   deploy does not run migrations**, so shipping os.capiro.ai is unaffected — but anyone
   deploying the API from main must apply them first.
6. **Fixture-green is not done.** Deploying has three times now revealed defects fixtures
   hid (ingestion telemetry in Needs Attention; recurring meetings collapsing by rendered
   time string; `/strategies` rendering a detail error). QA on os.capiro.ai against
   exported Figma nodes before calling anything finished.

## 10. Suggested order

1. **Merge to `main` first.** It is safe (§1), it unblocks everything, and it stops the
   parallel-branch problem that cost this session hours. Open one PR from
   `agent/web-vnext-figma-impl`. Before merging, re-check for *other* unmerged vNext
   branches: `git ls-remote --heads origin | grep -iE "vnext|os-"`.
2. **Read the three unread Handoff frames** (`788:2765`, `891:2593`, Strategies') — they
   may contradict what you think the scope is, as the Dashboard's did.
3. **Rebuild Strategies and LegiWatch properly** against `843:2502…` and `869:2502…`,
   removing antd. These are the two Neo called out as looking old.
4. **Build Program Elements** from `768:2502` — the seven visualisations already exist.
5. **Client Profiles** — resolve the design source with Neo first (§6).
6. One build, one deploy, then QA on os.capiro.ai against exported Figma nodes.

Publish Code Connect mappings for every new component as you go.
