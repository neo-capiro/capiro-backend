# Advocacy History — Closeout Handoff

Status: **PR #1253 merged. 14 closeout commits on `agent/advocacy-history-closeout`, all local — not pushed, no PR opened, no deploy performed.** Deploy/canary require explicit user approval per this session's standing constraint and have not been requested.

## SHAs

| What | SHA |
|---|---|
| Starting `main` (before #1253) | `c6ef14da701056b4b95a581181b92bbb133845f4` |
| PR #1253 head | `4d65d6f495a4d68c8de35d64616445315c413385` |
| PR #1253 merge commit (new `main`) | `e748645f47db7352ce71bdf29578a6234d0a9ff0` |
| Closeout branch base | `e748645f4` |
| Closeout branch HEAD (this doc's commit) | `53ba85af6c3c2fb57025dd91d69bf240e2dd323d` |
| Closeout PR | Not opened — awaiting explicit approval to push/open |
| Final merge SHA | N/A — not merged |

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

## CI status

GitHub Actions has a repo-wide `startup_failure` predating this closeout (noted in the original handoff). Not investigated or fixed as part of this work — out of scope, and the handoff's own framing treats it as a known, separate, pre-existing issue.

## Deployment SHA / canary result

**Not performed.** Deploy and production/internal canary explicitly require the user's approval per this session's standing instructions and have not been requested. Per section 34's own rule ("Do not declare Advocacy History complete until the production/internal canary succeeds"), **this closeout is not complete** — it is ready for review, not ready to be called done.

## Rollback

No migration has been applied to any shared environment — this branch has never been pushed or deployed. Rollback, if ever needed post-deploy, is: revert the closeout PR's merge commit, then `prisma migrate deploy` is a no-op (no new migrations this closeout beyond slice 3, which is already part of the merged PR #1253 lineage and was rehearsed for rollback compatibility along with the rest of the chain).

## Remaining debt

1. **Sources view (section 18, marked optional in spec) — not built.** The Matters/Timeline toggle exists; a third Sources view (per-source `lastSuccessfulAt`/`lastAttemptAt`/`lastError`/`recordCount` from `client_profile_fill_source_cursor`) does not. The cursor data itself is now correctly tracked for `advocacy_history` (LDA + client-submission + private-candidate watermarks) and `lifecycle_outcomes`, but no endpoint or UI reads it beyond the Fill pipeline's own internal `getCursor`.
2. **Attach to existing Matter / Create Matter on a still-*pending* Fill finding (sections 22/23) — not built, blocked on an unanswered product decision.** Asked three times this session (via the `clarify` tool) whether picking a Matter target on a pending finding should (a) tag it for later bulk-apply, skipping auto-clustering, or (b) immediately apply that one finding — no response received. What IS built: findings are grouped into their own "Advocacy History" section (not generic "Related context"), evidence/confidence/rationale render per finding, and "Not advocacy" (reusing the existing `reject` endpoint) works. Attach/Create-Matter on a pending finding requires a decision before implementation, since a wrong guess would mean rework across both the backend contract and frontend flow.
3. **CPF/CDS — genuinely zero coverage**, not a build gap so much as a data gap: no canonical table exists anywhere in the schema for either program. Confirmed via schema search, not assumed.
4. **Testimony granularity thinner than spec** — no dedicated `Testimony` model; represented via `CommitteeHearing.witnesses` (bare names only), honestly, not padded out with invented fields.
5. **Outcome matching steps 3–4** (regulatory docket, appropriations account exact match) not implemented — no evidence field exists yet in the outcome-detection pipeline's payloads to match against.
6. **`client-profile-fill-completion.helpers.ts`'s `scoreAdvocacyOutcome`** is an orphaned, byte-identical duplicate of the function actually used in the service file — confirmed via repo-wide import search that nothing references it, including tests. Pre-existing, left untouched per "do not redesign unrelated modules"; flagged here rather than silently fixed as a drive-by.
7. **`pnpm run lint` fails on both `apps/api` and `apps/web`**, repo-wide, pre-existing on `origin/main` — `eslint` is not a declared dependency anywhere in the monorepo, and no ESLint config file exists at all (confirmed via `find` on both this worktree and the untouched main clone). Two independent, compounding gaps, not something introduced or fixable within this closeout's scope without expanding into unrelated tooling work.
8. **GitHub Actions repo-wide `startup_failure`** — pre-existing, not investigated.
9. **Deploy, canary, and the closeout PR itself** — all pending explicit user approval, not performed.

## Definition of Done — self-assessment against the spec's 10 questions

A client user, from the current Advocacy Matters + Timeline experience, CAN answer: what are we advocating for (Matter title/summary/PE/bill), what Matter does this work belong to (every record/link names its Matter, including "Unassigned" when genuinely true), what did we actually do (Activity/Timeline chronology from real dates only), who did we engage (meeting/mail/outreach links with safe metadata), what public records substantiate the work (Regulations.gov/Federal Register/hearings/FARA links with evidence class + confidence), what bills/PEs/committees/agencies are involved (primary_pe_code/primary_bill_id, committee-code matching), what happened afterward (outcome links, deterministic-first matching), whether an outcome is merely related or confirmed (section 17 vocabulary, always-visible disclaimer), what evidence supports each claim (evidence class + confidence + provenance on every row), and what changed since the last refresh (incremental watermarks now cover all three Advocacy History discovery sub-pipelines, not just LDA).

What a client user **cannot** yet do: browse a dedicated Sources health view, or resolve an ambiguous Fill finding into a specific Matter before it's applied (both listed above as remaining debt, not silently gapped).
