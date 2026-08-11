# Client CRM vNext — backend contract audit

**Written:** 2026-08-11 · **Branch:** `agent/client-crm-vnext` (off `agent/web-vnext-figma-impl`)
**Normative contract:** Figma `1244:4222` — "Client CRM / 19 Implementation Contract · Agent Handoff"

The contract's §10 Definition of Done ends with: *"No product logic is invented from
placeholder copy; API gaps are implemented explicitly or surfaced as blocked acceptance
criteria."* This file is that surfacing. Every row was checked against the real Prisma
schema and the real controllers, not against a handoff doc.

## Routing reality that changes the plan

**There is no `/clients/:id` route.** The client profile is rendered *inside*
`ClientWorkspacePage` at `/clients?clientId=<id>&tab=<tab>`
(`apps/web/src/pages/clients/ClientWorkspacePage.tsx:62`, which says so in a comment).
Every legacy deep link in the contract is therefore a **query parameter**, not a path
segment. The vNext CRM must intercept `/clients` when `clientId` is present.

`VNextRouter` substitutes a vNext presentation at the canonical URL and falls through to
`<Outlet/>` otherwise — so interception preserves deep links, refresh and back/forward for
free. That is the mechanism to use; do not add a new route.

## Contract status per requirement

| Requirement (contract §) | Backend status | Evidence |
|---|---|---|
| **Fill with Meri** (§4) | ✅ **ALREADY BUILT — reuse, do not rebuild** | `agent/client-profile-fill-with-meri-v2`: `client-profile-fill.{controller,service,helpers}.ts` (2 288 lines) + 2 migrations. **Not merged to `main`.** |
| **Work = Strategies** (§8) | ✅ exists | Separate service at `/strategy-api/*` (own Fargate service). `StrategyListItem.clientId` exists, so a per-client projection is a filter, not a new store. |
| Targets / tier / recommendations | ✅ exists | `clients/client-targets.service.ts`, `client-target-recommendations.service.ts` |
| Facilities / district nexus | ✅ exists | `clients/client-facilities.service.ts`, `representation-resolver.service.ts` |
| Capabilities + advocacy history | ✅ exists | `clients/client-capabilities.service.ts`; `ClientCapability` model carries TRL/MRL/PE/appropriation/branch/subcommittee/funding-ask/justification/district-nexus/contracts |
| Files / uploads / KB status | ✅ exists | `/api/engagement/attachments*`, `/api/clio/kb/:id/status`; 25 MB cap enforced client-side today |
| Tracker / LegiWatch | ✅ exists | `clients/tracker/*`, `intelTrackerPaths`, flag `tracker_v2` |
| Meri client context/memory | ✅ exists | `MemoryFileEditor` + KB status already mounted in the legacy profile |
| **Person hierarchy** (§7) | ❌ **ABSENT — blocked** | `ClientPerson` (schema.prisma:2721) has `id/name/title/email/phone/role/lastContact/notes` and **no** `hierarchyLevel`, `reportsToPersonId`, `placementSource`, `confidence`, `reviewRequired`, `manualOverride` |
| **Normalized CRM activity** (§9) | ❌ **ABSENT — blocked** | No `client-activity` controller or model exists. Today `buildActivityItems()` fabricates 3 kinds (action/meeting/file) **in frontend memory**. The contract needs 9+ kinds incl. email/call/note/outreach/request/decision/commitment, durable, with pinned notes surviving reload. |
| **File folders + move-to-folder** (§12) | ❌ **ABSENT — blocked** | `EngagementAttachment` (schema.prisma:928) has no folder column. The only `folder` in the API is Outlook mail-folder parsing, unrelated. |

### What "blocked" means here

Three of the eighteen screens depend on a durable contract that does not exist:
`906:2790` (Organization hierarchy), `906:3360` (Relationship History), `907:3355`
(Move to Folder). Per the contract these must be **implemented properly or reported**,
and explicitly **not** faked in frontend state:

> *"Create or reuse a normalized durable CRM activity contract rather than fabricating
> these in frontend state."* (§9)
> *"If a backend contract required by the Figma does not exist, implement the contract
> properly or report it as an explicit blocked acceptance criterion. Do not fake the
> feature in frontend-only state."* (Definition of Done)

## Prior art on other branches — read before writing

| Branch | Carries | Merge state |
|---|---|---|
| `agent/client-profile-fill-with-meri-v2` | Fill with Meri backend + `ClientProfileFillDrawer.tsx` | not in `main` |
| `agent/client-profile-crm-cleanup` | Modular split of the profile into Overview/Relationships/Capabilities/Files/Intelligence | not in `main`; **independently re-creates `client-profile-crm-model.ts` that `main` already has via #892** — this is the recorded whole-file-fork trap. Do not merge it; port intent. |
| `main` @ `a169916c` (#892) | `client-profile-crm-model.ts` + `useClientProfileData.ts` | in `main`, and in this branch |

## Fill with Meri — the contract that already exists

Reuse this rather than inventing one. It maps 1:1 onto Figma §14's required states.

```
POST   /api/clients/:clientId/fill-with-meri/runs              start (standard_user)
GET    /api/clients/:clientId/fill-with-meri/latest            latest run
GET    /api/clients/:clientId/fill-with-meri/runs/:runId       poll
POST   /api/clients/:clientId/fill-with-meri/runs/:runId/apply apply findingIds (user_admin)
POST   /api/clients/:clientId/fill-with-meri/findings/:id/reject   (user_admin)
POST   /api/clients/:clientId/fill-with-meri/findings/:id/restore  (user_admin)
```

- `client_profile_fill_run.status` ∈ `running | completed | partial | failed`
  → drives *preparing / researching / proposals ready / partial-source failure*.
- `source_states_jsonb` → per-source failure, so **partial** is a real state, not a guess.
- `client_profile_fill_finding` carries `current_value_jsonb` → `proposed_value_jsonb`
  (the before → after diff), `evidence_jsonb` (source), `confidence` numeric(4,3),
  and `fact_kind` ∈ `fact | recommendation`.
- Apply takes an explicit `findingIds[]` — **no silent write** is structurally possible.
- `apply`/`reject` require `user_admin` while `start` requires `standard_user`
  → *permission denied* is a real, testable state, not decoration.

## Measured parity — Overview `906:2503` at 1600×1000

Measured with `getBoundingClientRect` against the live DOM in the Clerk-free
harness (`/vnext-shell.html?screen=client-crm`), not eyeballed from a
screenshot. Figma coordinates are page coordinates (working surface at x=232 /
y=108).

| Element | Figma | Measured | Δ |
|---|---|---|---|
| Working surface | 232, 108 · 1368×892 | 232, 108 · 1368×892 | **0** |
| Compact header | 232, 108 · 1368×120 | 232, 108 · 1368×121 | +1 (border) |
| Primary tabs | y 186 · h 42 | y 186 · h 42 | **0** |
| Client profile card | 256, 314 · 728×166 | 256, 315 · 728×165 | +1 / −1 |
| Account card | 1004, 314 · 572×166 | 1004, 315 · 572×165 | +1 / −1 |
| Needs attention | 256, 500 · 1320×248 | 256, 500 · 1320×247 | −1 |
| First attention row | y 555 · h 45 | y 556 · h 45 | +1 |
| Work pulse | 256, 768 · 650×206 | 256, 767 · 650×207 | −1 / +1 |
| Intelligence pulse | 926, 768 · 650×206 | 926, 767 · 650×207 | −1 / +1 |

All within the contract's ~2px tolerance. Three findings from the loop worth
keeping:

1. **A scrollbar is a 15px geometry bug, not a cosmetic one.** While the body
   overflowed by a few pixels, `.capiro-vnext-content`'s scrollbar shrank every
   card by 8–15px. Card widths only resolved to their Figma values once the
   content fit. Measure `scrollHeight > clientHeight` before trusting any width.
2. **The Figma header is absolutely positioned with overlapping bands.** The
   client mark sits at y=12 (36px tall) while the name's centre is at y=22 —
   the name is *not* centred against the mark. Reproduced by aligning the mark
   to the top of the identity row rather than centring it.
3. **The readiness percentage is beside the track, not beneath it** (`908:2983`
   at x=609). Stacking it added 18px and was the last thing forcing the scroll.

### Responsive stages

| Stage | Result |
|---|---|
| 1600 | Matches the table above; no scroll. |
| 1440 | Two-column regions preserved; no horizontal overflow. |
| 1200 | Two-column regions preserved; no horizontal overflow. **Nav is 232px, see below.** |
| 1024 | Nav 72px, two-column regions stacked, tabs do not overflow, no horizontal overflow. |

> **⚠ Contract conflict — needs a decision, not a silent fix.**
> §5 requires the **canonical 72px collapsed nav from 1200px down**. The shipped
> vNext shell collapses only at `max-width: 1024px`
> (`vnext/foundations/responsive.css`), so at 1200–1439 the rail is still 232px.
> Correcting it is a change to **shared shell infrastructure** that would also
> move Dashboard, Strategies and LegiWatch — all already shipped to
> os.capiro.ai. It is deliberately **not** changed here. Either the shell's
> breakpoint moves to 1439 for every family, or the CRM's §5 is relaxed.

## Final status — what shipped on this branch

All eighteen screens plus the contract are implemented. The three blocked
contracts were **implemented**, not deferred.

| Screen | Node | State |
|---|---|---|
| 01 Overview | `906:2503` | full Figma geometry, measured to ≤1px |
| 02 Relationships · Organization | `906:2790` | full Figma geometry (972 + 328 split) |
| 03 Relationships · Government | `906:3075` | built |
| 04 Relationships · History | `906:3360` | built on the new activity contract |
| 05 Work | `906:3645` | built as a Strategies projection |
| 06–11 Intelligence ×6 | `906:3930`…`907:2701` | built over `intelligence-v1` |
| 12 Files | `907:2810` | built on the new folder column |
| 13 Person drawer | `907:2919` | built |
| 14 Configure hierarchy | `907:3028` | built |
| 15 Current target drawer | `907:3137` | built |
| 16 Strategy detail drawer | `907:3246` | built |
| 17 Move to folder | `907:3355` | built |
| 18 Data health drawer | `907:3464` | built |
| Capabilities (§13) | no vNext design | compatibility surface, canonical drawer |

**Fidelity caveat, stated plainly.** Screens 01 and 02 were built from
`get_design_context` on their own nodes and 01 was verified by measuring the
rendered DOM. Screens 03–18 were built from the contract's explicit data-
ownership rules plus the card/row/drawer vocabulary established by 01 and 02;
their per-node Figma geometry has **not** been diffed. They are functionally
complete and visually consistent, but a per-screen pixel pass against
`get_design_context` is still owed before anyone calls them pixel-perfect.

### Contracts implemented here

| Contract | Migration | Notes |
|---|---|---|
| Person hierarchy | `20261120010000_client_person_hierarchy` | rules enforced in the DB, not only the service, because Meri's import also writes `client_people` |
| Normalized CRM activity | `20261120020000_client_activity` | recorded rows stored; meetings/attachments/outreach unioned at read time, never copied |
| File folders | `20261120030000_attachment_folder` | a column, so a move never copies the S3 object |
| Fill with Meri | `20261015010000` + `20261015020000` | taken from `agent/client-profile-fill-with-meri-v2` (API only) |

**Five migrations must be applied before the API is deployed.** A web-only
WebVNext deploy is unaffected.

## Blast radius — why app.capiro.ai cannot break

- **Zero** web files outside `apps/web/src/vnext/` were changed
  (`git diff --name-only agent/web-vnext-figma-impl..HEAD -- apps/web/src`
  returns nothing outside that directory).
- `App.tsx` branches hard: `if (isVNextSurface) return <VNextApp/>; return <AppShell/>;`
  and the surface comes from `WEB_SURFACE`, set per ECS task definition.
- Verified live, not from a doc: `capiro-dev-web:72` (the task definition
  app.capiro.ai is running) has **no** `WEB_SURFACE` variable, so it resolves to
  `canonical` and never loads a vNext module.

**The API is shared, and it did change** — additively:
new controllers/services, five new migrations, new nullable columns. The one
edit to existing behaviour is `ClientPeopleService.createPerson/updatePerson`,
which now populates the new hierarchy columns. It writes only new nullable
fields and changes no response field the legacy profile reads, but it is a
shared-path change and should be reviewed as one.

## Decisions taken from this audit

1. Build on `agent/web-vnext-figma-impl` (PR #906), not `main` — the vNext shell,
   tokens and mapped primitives only exist there.
2. Reuse `CapiroButton` / `CapiroBadge` / `GlobalSearch` / shell. No re-drawn primitives.
3. Intercept `/clients` in `VNextRouter`; keep `?clientId=` and add `?tab=` / `?view=`.
4. Cherry-pick the Fill with Meri backend rather than writing a second one.
5. Hierarchy, normalized activity and folders each need a migration + service before
   their screens can be honest. They are tracked as blocked acceptance criteria.
