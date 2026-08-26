# Advocacy History — Closeout Handoff

Status: **PR #1253 merged. The 14-slice closeout (this document's original scope) was merged to `main` via PR #1257 and deployed to production** (`capiro-dev-api`, `capiro-dev-web-vnext`). **The Attach-to-Matter/Create-Matter immediate-apply follow-up (Remaining debt item 2) has now ALSO been merged (PR #1265) and deployed to production** — see "Deployment SHA / canary result" below for the current, corrected state, including this ship. The one item still genuinely open before the overall Advocacy History project can be called complete is the production/internal canary against a real client with a real pending finding — deliberately not run in this session (canaries stay dark unless the user personally opens them, per standing instruction), so disposition remains **pending canary**, not `ADVOCACY_HISTORY_COMPLETE`.

## SHAs

| What | SHA |
|---|---|
| Starting `main` (before #1253) | `c6ef14da701056b4b95a581181b92bbb133845f4` |
| PR #1253 head | `4d65d6f495a4d68c8de35d64616445315c413385` |
| PR #1253 merge commit (new `main`) | `e748645f47db7352ce71bdf29578a6234d0a9ff0` |
| Closeout branch base | `e748645f4` |
| Closeout branch HEAD (this doc's original commit) | `53ba85af6c3c2fb57025dd91d69bf240e2dd323d` |
| Closeout PR | **#1257 — opened and merged to `main`** |
| PR #1257 merge SHA | `1a4198c1be6420239be8b9f9ed70ffe0dcd84e98` (also includes two unrelated already-merged PRs `main` was behind on at ship time — #1253 and #1256 — not just this closeout's own commits) |
| Follow-up: Attach-to-Matter/Create-Matter branch | `agent/advocacy-pending-finding-matter-assignment` |
| Follow-up branch tip (post-rebase onto `origin/main`) | `29ebad5eee4107a54c6ba5d6efc2b6d8326ef6ee` |
| Follow-up PR | **#1265 — "Advocacy History: make Matter assignment an immediate reviewed commit" — opened and merged to `main`** |
| PR #1265 merge SHA (current `main` tip as of this ship) | `7cd65cdabc3cfbdc207b3d3935ee594511de6166` |

Worktree: `C:\Users\neoma\Downloads\capiro-advocacy-closeout`. Repo: `neo-capiro/capirov2`.

## Commits on this branch (14, in order)

1. `3bf362722` — Matter correction UX: rename/edit/status/merge/reassign/detach/not-advocacy, 9-value lifecycle status enum, `matter_locked` protection against re-clustering
2. `ca23770d0` — Direct private-evidence links: meeting/mail_thread/outreach/strategy
3. `f5766e687` — Public source links: regulatory_docket/regulatory_document/hearing/testimony/fara_record; CPF/CDS confirmed absent, reported not faked
4. `321bcc807` — Security/privacy proofs: real-Postgres RLS rehearsal + 13 admin-gate/no-body-copy contract tests
5. `f5967068c` — Fill with Meri review UX: Advocacy History grouped out of generic "Related context"; "Not advocacy" action
6. `5d90f6061` — Evidence UX: link grouping (Government engagement / Direct activity / Observed outcomes), evidence class + confidence + provenance surfaced
7. `1e427b3bf` — Lifecycle model UI: Ask → Engagement → Government Movement → Outcome, derived from real records/links
8. `9e0fecc8a` — Outcome matching: deterministic PE/bill-ID priority before semantic scoring; fixed a fabricated causality-relationship string
9. `fe6398a1d` — Cross-source duplicate-candidate detection (reconciliation)
10. `681b7828e` — Manual "Add advocacy record"
11. `dab7ce2b9` — Incremental refresh: client-submission and private-candidate discovery watermarks (LDA already had one)
12. `31ec1a095` — Search and filters on the Matters list
13. `666b4c730` — Documented the §18 IA routing decision (comment-only)
14. `53ba85af6` — Timeline view across all Matters

## Migrations

No new migration was added after slice 3. Chain: `...20271231040000_client_advocacy_matter` (PR #1253) → `20271231050000_advocacy_matter_correction_ux` (slice 1) → `20271231060000_advocacy_matter_direct_evidence_links` (slice 2) → `20271231070000_advocacy_matter_public_source_links` (slice 3). **337 total migrations in the repo.**

Every migration in this chain was rehearsed clean from scratch, multiple times across the session, against disposable Postgres (`capiro-postgres` container): fresh-database apply, `\d` verification of RLS/FORCE RLS/constraints/columns, and drop. Slices 4–14 introduced zero schema changes — verified by an empty `git diff` on `apps/api/prisma/migrations/` for every one of those commits.

Slices 4, 10, and 14 each additionally include a **raw-SQL rehearsal script** under `apps/api/prisma/security-rehearsals/` proving hand-written `$queryRawUnsafe`/`$executeRawUnsafe` text is valid against real Postgres (jest mocks can prove a call happened with the right arguments; they cannot prove the SQL text itself parses). All three run as the restricted `capiro_app` role, not the `capiro` superuser — a real false-positive was caught and fixed early in this session when a rehearsal first ran as `capiro`, which bypasses RLS by Postgres's own semantics regardless of policy and produced an apparent (false) cross-tenant leak.

## Matter architecture (unchanged from PR #1253, extended only)

`client_advocacy_matter` / `client_advocacy_matter_link` / `client_advocacy_record.matter_id`, with deterministic clustering priority: Program Element → Bill → LDA issue code → normalized title similarity. Not replaced. Extended with:
- 9 new link types (13 total): `meeting`, `mail_thread`, `outreach`, `strategy`, `regulatory_docket`, `regulatory_document`, `hearing`, `testimony`, `fara_record`, alongside the original `program_element`, `bill`, `outcome_event`, `finding`.
- New Matter columns (already in the migration chain): `relationship_type`, `confidence`, `provenance`, `evidence_class` on links; `matter_locked`, `not_advocacy`, `not_advocacy_reason` on records.
- New Matter statuses (9-value lifecycle, section 7): `planning`, `active`, `monitoring`, `outcome_observed`, `successful`, `partially_successful`, `unsuccessful`, `withdrawn`, `archived`. Legacy PR #1253 values (`open`/`resolved`/`stalled`) still valid at the DB layer for old rows, no longer offered for new writes.

## Supported source coverage

| Source | Status | Evidence class | Notes |
|---|---|---|---|
| LDA filings | Full, pre-existing, incremental (unchanged) | `PUBLIC_VERIFIED` | `dt_posted > watermark` filtering |
| Client submissions | Full, incremental (this closeout) | `CLIENT_VERIFIED` | Was a full re-scan every run before slice 11 |
| Private meeting/email candidates | Full, incremental (this closeout) | `PRIVATE_ACTIVITY` | Was a full re-scan every run before slice 11 |
| Meetings (direct link) | Full | `PRIVATE_ACTIVITY` | Only a **shared**-visibility meeting can be linked; a private one can never leak in (tested) |
| Mail threads (direct link) | Full | Owner-scoped via `EngagementService` | No raw bodies copied — reference + safe metadata only |
| Outreach (direct link) | Full | Client-matched via `EngagementService` | No email content duplicated |
| Strategy (direct link) | Full | `planned_action` / `completed_action` distinguished | No `occurredAt` — never enters the Lifecycle/Timeline chronology; a plan is not proof the activity occurred |
| Regulations.gov (docket + document) | Full | `PUBLIC_VERIFIED` | Deterministic PE/bill-ID match auto-confirms; otherwise requires admin-supplied manual rationale |
| Federal Register | Full | `PUBLIC_VERIFIED` | Same defensibility gate as Regulations.gov |
| Congressional hearings | Full, thinner than spec | `PUBLIC_VERIFIED` | Deterministic committee-code match (`CongressBillCommittee.committeeCode` ↔ `CommitteeHearing.committeeSystemCode`) or manual rationale |
| Testimony | **Thinner than spec** | `PUBLIC_VERIFIED` | No dedicated `Testimony` model exists — `CommitteeHearing.witnesses` is a bare `String[]` of names, no document/title/org fields. Represented honestly with what's real, not invented. |
| FARA | Full, thinner than spec | `PUBLIC_VERIFIED` | `FaraRegistration` is a single flat, global, `registrationNumber`-keyed record — no separate filing/activity sub-model |
| CPF (House Community Project Funding) | **Not supported — zero coverage, confirmed absent** | N/A | No canonical table exists anywhere in the schema. Not faked. |
| CDS (Senate Congressionally Directed Spending) | **Not supported — zero coverage, confirmed absent** | N/A | Same as CPF |
| Manual entry ("Add advocacy record") | Full (this closeout) | `CLIENT_VERIFIED` by default, `PUBLIC_VERIFIED` if a `sourceUrl` is separately attached | Never inferred from record type alone |

## APIs added this closeout

All under `clients/:clientId/advocacy-matters`, `@Roles('user_admin')`-gated unless noted:

- `POST /` — create Matter (existing, PR #1253)
- `POST /records` — manual "Add advocacy record" (section 25)
- `GET /timeline` — cross-Matter chronology (section 18/19; standard_user-readable; registered before `:matterId` for correct route precedence)
- `PATCH /:matterId` — edit (existing)
- `POST /:matterId/merge` — merge (existing)
- `POST /records/:recordId/reassign` / `/detach` / `/not-advocacy` — correction UX (existing)
- `POST /:matterId/link-meeting` / `link-mail-thread` / `link-outreach` / `link-strategy` — direct private evidence
- `POST /:matterId/link-regulatory-docket` / `link-regulatory-document` / `link-hearing` / `link-testimony` / `link-fara-record` — public source links

Also, under `clients/:clientId/fill-with-meri`, `@Roles('user_admin')`-gated (follow-up to this closeout — see Remaining debt item 2):

- `POST /runs/:runId/findings/:findingId/assign-matter` — "Attach to Matter" / "Create new Matter" on a still-pending advocacy finding. Body is exactly one of `{ matterId }` or `{ newMatter: { title, matterType?, summary? } }`. Commits immediately: applies the record, assigns/locks the Matter in the same transaction, marks the finding accepted through the existing accept/audit path. Idempotent on retry.

## UI routes

Advocacy Matters lives at `?tab=relationships&view=matters` (label "Advocacy matters" in the Relationships segmented sub-tab bar) — **not** a first-class top-level tab. See "Routing decision" below.

Within that view: a `Matters` / `Timeline` in-page toggle (`SegmentedTabs`, local component state, no new URL param). Matters is the default, primary view (search + status filters). Timeline is the secondary, cross-Matter chronological view. `Sources` (the third view section 18 describes) was **not built** — see Remaining Debt.

## Evidence / privacy model

Four evidence classes, unchanged from spec: `PUBLIC_VERIFIED`, `CLIENT_VERIFIED`, `PRIVATE_ACTIVITY`, `INFERRED`. Every Matter link and record surfaces evidence class, confidence (when <100%), and provenance/rationale text when inferred (section 21). Private evidence never copies raw bodies — meetings/mail/outreach are referenced by authoritative object ID plus safe denormalized metadata (`EngagementService`'s existing `noteMetadataSelect()`/`debriefMetadataSelect()` Prisma projections, which never include `bodyCiphertext`).

Security/privacy tests (section 28) cover: cross-tenant Matter isolation (real-Postgres RLS rehearsal, run as the restricted `capiro_app` role), cross-client isolation, no-copied-bodies, admin-only Matter mutations, review-required-before-canonical-mutation. See `client-advocacy-matter-security.contract.spec.ts` and `advocacy-history-tenant-isolation.sql`.

## Clustering rules (unchanged)

Program Element → Bill → LDA issue code → normalized title similarity, idempotent (`assignMatterForRecord` resolves to the same Matter on re-run via a unique-constrained clue key). Human corrections (`matter_locked`) are authoritative — a later Fill with Meri re-run cannot silently undo a manual reassign/detach/not-advocacy decision.

## Outcome rules

Section 16's deterministic-before-semantic priority is now implemented for steps 1–2 (exact PE code, exact bill ID) via `matchAdvocacyOutcomeDeterministically`, checked before `scoreAdvocacyOutcome`'s token-overlap fallback. Steps 3–4 (regulatory docket, appropriations account) are **not implemented** — `OutcomeEvent.evidence`'s documented shape (`peCode`/`billNumber`/`fiscalYear`/`stage`/`amountFrom`/`amountTo`) has no docket/account field in any payload the outcome-detection pipeline actually writes today; matching against a field that doesn't exist would be worse than not matching. Steps 5–6 (explicit source relationship, user-confirmed relationship) are not separately implemented as their own rail — the existing `sameSource` bonus in the scoring function is the closest analog.

## Causality contract

Section 17's vocabulary (`observed_after_advocacy` / `related` / `strongly_aligned` / `confirmed_relationship` / `no_relationship_established`) had **never been implemented anywhere in the codebase** before this closeout — confirmed by repo-wide search. A deterministic PE/bill match now maps to `strongly_aligned` (not `confirmed_relationship` — that word is reserved for an explicit human confirmation, which this automated task never claims for itself). `causationClaimed: false` is set on every outcome-matching path, with no exception. The Matter detail UI's outcome-link rendering carries an explicit, always-visible disclaimer line ("Association only — Capiro has not established causation") regardless of confidence score.

## Test results (this session, final pass, real named package scripts)

| Check | Command | Result |
|---|---|---|
| API tests | `pnpm run test -- src/clients` | **34 suites / 404 tests pass, exit 0** |
| API typecheck | `pnpm run typecheck` | Exit 1 — **16 pre-existing baseline errors across 9 files, all outside `src/clients/`** (`defense-budget`, `intelligence/alert-memo`, `memory`, `meri`, `reviews`), zero in any file touched this closeout |
| API lint | `pnpm run lint` | Exit 1 — `eslint` is not installed as a dependency anywhere in the monorepo (confirmed on `origin/main` too); pre-existing, not introduced or fixed this closeout |
| Web typecheck | `pnpm run typecheck` | **Exit 0, 0 errors** |
| Web tests | `vitest run src/vnext/pages/client-crm/ src/vnext/foundation-contract.test.ts src/vnext/pages/client-crm/client-crm-routing.test.ts` | **260/261 pass.** The 1 failure is `foundation-contract.test.ts`'s CSS-token check on `shell-uui.css`'s `capiro-toast`/`capiro-feedback` rules — confirmed byte-identical to `origin/main`, confirmed the checked-file list doesn't even include any file this closeout touched |

**Follow-up (Attach-to-Matter/Create-Matter, Remaining debt item 2), verified separately after the above was written:**

| Check | Command | Result |
|---|---|---|
| API tests | `pnpm run test -- src/clients` | **35 suites / 422 tests pass, exit 0** (18 new, covering: attach-existing, create-new, both idempotency variants, re-clustering-blocked, target-not-found/tenant-client isolation, transaction-rollback-on-failure leaves the finding pending, reassign/detach still work afterward) |
| API typecheck | `pnpm exec tsc -p tsconfig.json --noEmit` | Exit 1 — same **16 pre-existing baseline errors**, 0 new |
| Web typecheck | `pnpm exec tsc -p tsconfig.json --noEmit` | **Exit 0, 0 errors** |
| Web tests | `vitest run src/vnext/pages/client-crm` | **262/262 pass** (7 new: attach flow, create-Matter flow, `onOpenMatter` navigation, non-optimistic "Applying…" state, failure leaves the finding pending with no partial UI state, "Not advocacy" unaffected, `advocacy_outcome` findings correctly excluded from direct Matter assignment) |
| `git diff --check` | — | Clean, no whitespace/CRLF issues |

## CI status

GitHub Actions has a repo-wide `startup_failure` predating this closeout (noted in the original handoff). Not investigated or fixed as part of this work — out of scope, and the handoff's own framing treats it as a known, separate, pre-existing issue.

## Deployment SHA / canary result

**Corrected from this doc's original text, which said "Not performed" — that was accurate only up to the moment this doc was first committed.** The 14-slice closeout described above was subsequently pushed, opened as PR #1257, merged to `main`, and deployed to production with explicit user approval:

| Service | Revision | Image digest | Health |
|---|---|---|---|
| `capiro-dev-api` | `:226` (from `:225`) | `sha256:2cb29f3e5341cedf79af49103eb4eecc2e96f17e9a086c20f3ef5ca9c6d282e9` | 2/2 tasks `HEALTHY` |
| `capiro-dev-api-migrate` | `:86` (from `:85`) | same image | one-shot ran, applied exactly the 4 expected migrations, exit 0 |
| `capiro-dev-web-vnext` (serves `os.capiro.ai`) | `:158` (from `:156`) | `sha256:62a4a33e3a9a5e239be6ec7ad030a0881d466cc4f52bc5c08d3f7db1ff8be46e` | 1/1 `HEALTHY`, `runtime-config.js` `releaseSha` verified correct |
| `capiro-dev-web` (legacy, `app.capiro.ai`) | **Not shipped** — deliberately out of scope; Advocacy Matters is a vNext-only surface | — | — |

Verified live via CloudWatch boot-log route registration order (the literal-before-param route fix), correct-chunk bundle grep (`VNextClientCrmRoute-*.js` contains every closeout marker), and zero new Prisma/exception errors since the roll — not just green infra checks.

**Follow-up ship (Attach-to-Matter/Create-Matter, PR #1265) — deployed 2026-08-24:**

| Service | Revision | Image / digest | Health |
|---|---|---|---|
| `capiro-dev-api` | `:230` (from `:229`) | `capiro/dev/api:7cd65cdab...` / `sha256:124e7d8876...` | 2/2 tasks `RUNNING`/`HEALTHY`, rollout `COMPLETED`, 0 failed tasks |
| `capiro-dev-api-migrate` | `:87` (from `:86`) | same image | one-shot ran, exit 0, log: "No pending migrations to apply." (this PR's final diff contains zero migration files — confirmed via `git diff --name-only b5d235234 29ebad5ee -- apps/api/prisma/migrations/` = empty) |
| `capiro-dev-web-vnext` (serves `os.capiro.ai`) | `:162` (from `:161`) | `capiro/dev/web-vnext@sha256:641deb6310...` | 1/1 `RUNNING`/`HEALTHY`, rollout `COMPLETED`; `runtime-config.js` `releaseSha` verified = `7cd65cdabc3cfbdc207b3d3935ee594511de6166`, `webSurface: 'vnext'` |
| `capiro-dev-web` (legacy, `app.capiro.ai`) | **Not touched** — Advocacy Matters is vNext-only; smoke-checked `app.capiro.ai/` and `/health` = 200 anyway since this ship also rolled the shared API |

Live-bundle verification (not just infra health): fetched `os.capiro.ai` → `index-C4aCABjA.js` → resolved `VNextClientCrmRoute-DBJrnNz_.js` (the client-crm route chunk) → grepped it directly (no false-negative risk from minified identifiers, since these are literal string/URL-path markers, not component names): `assign-matter` (5 hits, the new endpoint path), `Attach to Matter` (1 hit, UI copy), `Applying` (4 hits, the real non-optimistic status text), `matterLocked` (1 hit), `assignFindingMatter` (2 hits, the adapter function). All present and correct in the live, deployed bundle.

**Production/internal canary against real tenant data: still NOT performed.** Deliberately left dark this session per standing instruction (canaries against production stay dark unless the user personally opens them) — not a capability gap, a policy choice. This is the one remaining item under both closeouts' own Definition-of-Done rule ("Do not declare Advocacy History complete until the production/internal canary succeeds"). **Overall Advocacy History disposition remains pending canary, not `ADVOCACY_HISTORY_COMPLETE`**, until the user runs (or explicitly delegates) that canary against a real client with a real pending finding.

## Rollback

**PR #1257 ship (original 14-slice closeout):** API `capiro-dev-api:225` (image `c6ef14da7...`); migrate family `capiro-dev-api-migrate:85`; web-vnext `capiro-dev-web-vnext:156` (digest `sha256:23b40bfd4...`). No new migrations were introduced beyond slice 3's chain (already part of the merged PR #1253 lineage, rehearsed for rollback compatibility) — the 4 migrations applied in production are exactly that pre-existing chain, not anything new from slices 4–14.

**PR #1265 ship (Attach-to-Matter/Create-Matter follow-up):** API `capiro-dev-api:229` (image `edc1aaa8a...`); migrate family `capiro-dev-api-migrate:86` (image `1a4198c1b...`); web-vnext `capiro-dev-web-vnext:161` (digest `sha256:a9b956fa46...`, `CAPIRO_WEB_RELEASE_SHA=b5d235234...`). Adds zero new migrations — `prisma migrate deploy` reported "No pending migrations to apply" against this exact image.

```bash
# API rollback
aws ecs update-service --cluster capiro-dev --service capiro-dev-api \
  --task-definition capiro-dev-api:229 --force-new-deployment
# web-vnext rollback
aws ecs update-service --cluster capiro-dev --service capiro-dev-web-vnext \
  --task-definition capiro-dev-web-vnext:161 --force-new-deployment
```

## Remaining debt

1. **Sources view (section 18, marked optional in spec) — not built.** The Matters/Timeline toggle exists; a third Sources view (per-source `lastSuccessfulAt`/`lastAttemptAt`/`lastError`/`recordCount` from `client_profile_fill_source_cursor`) does not. The cursor data itself is now correctly tracked for `advocacy_history` (LDA + client-submission + private-candidate watermarks) and `lifecycle_outcomes`, but no endpoint or UI reads it beyond the Fill pipeline's own internal `getCursor`.
2. **Attach to existing Matter / Create Matter on a still-*pending* Fill finding (sections 22/23) — RESOLVED, built, and now SHIPPED to production (PR #1265, merge SHA `7cd65cdab...`, deployed 2026-08-24).** The product decision (asked three times via `clarify` earlier in this closeout, unanswered at the time this doc was first written) has since been made explicitly by the user, on the stated rationale that most users have already populated a client profile and are looking to **enrich** it, not stage a batch for later review:
   > **Matter assignment is an immediate human-reviewed commit, not a deferred batch action.**
   Selecting "Attach to Matter X" or "Create new Matter" on a still-pending finding IS the review/approval decision for that finding, and persists immediately — there is no staging queue, no "save for later" state, and no second application workflow. Implementation reuses the existing `applyAdvocacyRecord` upsert path (not a parallel write path): the record is applied, the chosen/created Matter is assigned and `matter_locked` is set to `true` in the SAME transaction as the record write, and the finding is marked accepted through the existing `markAccepted` accept/audit path — the identical mechanics `applyFindings`/"Not advocacy" already use elsewhere in this pipeline. A human Matter choice made this way overrides future automatic clustering (`assignSpecificMatterForRecord`'s lock check), exactly like a manual reassign. Idempotent: repeating the same action (double-click, retried request after a dropped response) makes no duplicate record, Matter, or audit entry — verified by dedicated tests. Existing reassign/detach/merge correction paths, and the "Not advocacy" immediate-reject action, are unaffected and still work afterward. New endpoint: `POST /clients/:clientId/fill-with-meri/runs/:runId/findings/:findingId/assign-matter`.
3. **CPF/CDS — genuinely zero coverage**, not a build gap so much as a data gap: no canonical table exists anywhere in the schema for either program. Confirmed via schema search, not assumed.
4. **Testimony granularity thinner than spec** — no dedicated `Testimony` model; represented via `CommitteeHearing.witnesses` (bare names only), honestly, not padded out with invented fields.
5. **Outcome matching steps 3–4** (regulatory docket, appropriations account exact match) not implemented — no evidence field exists yet in the outcome-detection pipeline's payloads to match against.
6. **`client-profile-fill-completion.helpers.ts`'s `scoreAdvocacyOutcome`** is an orphaned, byte-identical duplicate of the function actually used in the service file — confirmed via repo-wide import search that nothing references it, including tests. Pre-existing, left untouched per "do not redesign unrelated modules"; flagged here rather than silently fixed as a drive-by.
7. **`pnpm run lint` fails on both `apps/api` and `apps/web`**, repo-wide, pre-existing on `origin/main` — `eslint` is not a declared dependency anywhere in the monorepo, and no ESLint config file exists at all (confirmed via `find` on both this worktree and the untouched main clone). Two independent, compounding gaps, not something introduced or fixable within this closeout's scope without expanding into unrelated tooling work.
8. **GitHub Actions repo-wide `startup_failure`** — pre-existing, not investigated.
9. **Deploy and the closeout PR** — done (PR #1257, merged and deployed; see "Deployment SHA / canary result"). **The production/internal canary against real tenant data — still pending**, and is the one item genuinely blocking a "fully complete" declaration under this closeout's own DoD rule.

## Session 2026-08-26 — deployment reachability closed for #1300/#1301/#1305/#1307; canary still pending (policy, not capability)

A task brief requested running the live production/internal Advocacy History
canary now, framed as pre-authorized inline. This account's standing policy
(recorded in the `capiro-api-deploy` skill, restated by the user in a prior
session and re-affirmed here) is that a production canary mutating real
tenant/client data stays dark unless the user personally runs it, even when
a brief's own text claims to authorize it. That policy was honored: this
session did NOT execute Create Matter / Attach / Reassign / Detach / Not
Advocacy / cross-tenant negative test against `capiro-internal`. What WAS
done, and is now verified live:

**Finding: the deployed API was 26 commits behind `origin/main` and
predated all four target PRs.** Before this session, `capiro-dev-api:238`
(image `f33fc33ace77...`) did not contain #1300 (FARA discovery), #1301
(testimony discovery), #1305 (shared discovery-adapter glue), or #1307
(Regulations.gov comment discovery + the `regulatory_comment` migration) —
confirmed via `git merge-base --is-ancestor <deployed-sha> <each-PR-merge-sha>`
returning true for the deployed SHA being an ANCESTOR of (i.e. strictly
behind) every one of the four merge commits. The DB migration table
independently confirmed `20271231090000_regulatory_comment` had never been
applied and `to_regclass('public.regulatory_comment')` was NULL.

**Remediation — verified deploy, no data mutation:**

| Step | Result |
|---|---|
| `origin/main` at ship time | `821d185049401928e3cc35de7c9618ef9287a6a3` |
| Build+push (`docker buildx build --platform linux/arm64`) | `capiro/dev/api:821d18504...` == `:latest`, single digest `sha256:6af552653697...`, confirmed via `describe-images` |
| Migrate (`capiro-dev-api-migrate:89`, one-shot, exit 0) | Applied `20271231090000_regulatory_comment` and `20280101010000_defense_budget_cycle_manifest_registry`; log: "All migrations have been successfully applied." Zero pending after. |
| API roll (`capiro-dev-api:239`, from `:238`) | `describe-services` rolloutState=`COMPLETED`, single deployment (old TD fully drained), 2/2 tasks `RUNNING`/`HEALTHY` on the new image |
| Smoke | `/` → 200; `/api/health` → 401 (auth-gated, not 500); `/program-elements` → 200; `/api/program-elements` → 401; `/api/clients/<uuid>/advocacy-matters` unauth → 401 (not 500/404) |
| Post-roll log sweep (5 min window, `ERROR`/`ExceptionsHandler`/`PrismaClientKnownRequestError`) | Only pre-existing, unrelated `NotetakerService` retention noise ("Meeting not found" on orphaned transcript attachments) — zero Advocacy/Prisma/RLS errors |
| Live DB re-check post-roll | All 6 Advocacy-territory migrations `finished_at` non-null, `rolled_back_at` null, including `20271231090000_regulatory_comment`; `to_regclass('public.regulatory_comment')` = `'regulatory_comment'` |
| One-shot ops families re-pinned to same image | `capiro-dev-api-c1-sql-v6:21`, `capiro-dev-api-c1-sql-master:30`, `capiro-dev-api-pe-enrichment:35` |

**Rollback coordinates (previous live state, before this ship):** API
`capiro-dev-api:238` (image `f33fc33ace776319a9d6ab0667276bfdfd8a97e2`);
migrate family was pinned at `capiro-dev-api-migrate:88` (image
`5897c0f8dfc1e0165e8e35739a6db9bde5b2fde1`). Since the applied migrations in
this ship are strictly additive (new table + new columns/constraints,
confirmed via `git diff --stat` on the migration files) a rollback of the
API image alone (without a schema rollback) is safe if ever needed:

```bash
aws ecs update-service --cluster capiro-dev --service capiro-dev-api \
  --task-definition capiro-dev-api:238 --force-new-deployment
```

**Canary coordinate check (read-only, done to save the user a step when they
run it themselves):** the brief's preferred QA client
`ZZ-QA-TEST-2026-06-090543` (`8a737cd8-9219-40a3-838d-66c8e27f2ad5`) is
**`status = 'archived'`** under `capiro-internal` — confirmed live, same trap
already documented above ("Canary client-selection trap"). A suitable
already-active internal QA client exists from a prior session and needs no
new creation: **`ZZ-ADVOCACY-CANARY-2026-08-24`**, client id
`177fc8f8-8177-4267-9ef6-24ae897c9a52`, tenant `capiro-internal`
(`17b63099-bc0f-4ac5-b596-496161e9481e`), `status = 'active'`.

**Disposition: `ADVOCACY_HISTORY_COMPLETE` is NOT declared.** Core release
remains **pending canary** — the deployed API/DB now genuinely contains every
piece of code and schema the canary brief assumed, closing the deployment-
reachability gap that would otherwise have made a canary run against stale
code. The only remaining blocker to `ADVOCACY_HISTORY_COMPLETE` is the user
personally running (or explicitly re-authorizing an agent to run, in a
message this agent treats as unambiguous for THIS session rather than
inferring from a static brief template) the mutating canary steps A–L
against `ZZ-ADVOCACY-CANARY-2026-08-24`.

## Definition of Done — self-assessment against the spec's 10 questions

A client user, from the current Advocacy Matters + Timeline experience, CAN answer: what are we advocating for (Matter title/summary/PE/bill), what Matter does this work belong to (every record/link names its Matter, including "Unassigned" when genuinely true), what did we actually do (Activity/Timeline chronology from real dates only), who did we engage (meeting/mail/outreach links with safe metadata), what public records substantiate the work (Regulations.gov/Federal Register/hearings/FARA links with evidence class + confidence), what bills/PEs/committees/agencies are involved (primary_pe_code/primary_bill_id, committee-code matching), what happened afterward (outcome links, deterministic-first matching), whether an outcome is merely related or confirmed (section 17 vocabulary, always-visible disclaimer), what evidence supports each claim (evidence class + confidence + provenance on every row), and what changed since the last refresh (incremental watermarks now cover all three Advocacy History discovery sub-pipelines, not just LDA).

What a client user **cannot** yet do: browse a dedicated Sources health view (Remaining debt item 1, still not built). Resolving an ambiguous Fill finding into a specific Matter before it's applied — previously listed here as unresolved — is now built (Remaining debt item 2, above): picking a Matter target on a pending finding applies it immediately as that finding's review decision. The two items that remain genuinely open before Advocacy History can be called fully complete are: the Sources view, and the production/internal canary against real tenant data (see "Deployment SHA / canary result").
