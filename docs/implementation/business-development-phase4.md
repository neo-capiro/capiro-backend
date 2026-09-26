# Business Development Phase 4 — Meri prospect briefs and firm workflow

Date: 2026-09-25

Status: deployed to the authorized `capiro-internal` cohort on the AWS `capiro-dev` cluster. The brief and prospect-scoped Meri flags are enabled for that tenant; deterministic claim validation remains disabled and semantic Phase 3 `BD-CLAIM` Jev remains dark. The final deployed application SHA is `4e30ad8f05ff4afcd0a983b46b424dda05d6d505`.

## Dependency map and delivered scope

Phase 4 composes the existing product surfaces rather than replacing them:

| Dependency                 | Reused authority                                                                                                                         | Phase 4 use                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1 prospect workspace | Tenant-owned prospect, owner/stage/history, canonical identity, confirmed client link, roles, and conversion                             | Briefs and Meri conversations are anchored to the existing prospect ID. An unlinked prospect remains client-less until the existing link/convert flow succeeds.                                                    |
| Phase 2 evidence dossier   | Permission-filtered evidence, source registry, stable record IDs/locators, dates, coverage, and source status                            | Initial briefs and refresh proposals use immutable bounded source snapshots. Citation inspection resolves against the saved snapshot and current authorized dossier.                                               |
| Phase 3 claim controls     | Shared `BD-CLAIM` contract and deterministic exact-field rules                                                                           | Exact identity, citation, amount, date, and financial-stage checks are available behind a separate flag. Semantic Jev validation remains dark because the human-reviewed Phase 3 evaluation gate is not satisfied. |
| Meri                       | Existing conversation persistence, runtime adapters, native tool registry, system-prompt construction, approval flow, and tool telemetry | Prospect scope is resolved and persisted by the server, reauthorized before every runtime dispatch and tool call, and displayed on each assistant receipt.                                                         |
| Engagement Manager         | Existing client notes, tasks, meeting preparation, outreach records, connected-mail checks, and send approval                            | A confirmed linked client is bound to the prospect conversation after the existing visibility check. Phase 4 adds no parallel action service and no sender.                                                        |

The principal implementation lives in:

- `apps/api/src/business-development/bizdev-brief.service.ts` and `bizdev-brief.util.ts` — versioned brief lifecycle, immutable evidence snapshots, refresh diff, citation resolution, and deterministic claim checks.
- `apps/api/src/business-development/bizdev-meri-scope.service.ts` — server-resolved tenant/user/prospect scope and scope-version reauthorization.
- `apps/api/src/meri/meri-bizdev-tools.service.ts` — four bounded read tools and one approval-classified brief write tool.
- `apps/api/src/meri/meri-prospect-scope.helpers.ts` plus the legacy, V2, V3, and Hermes runtime adapters — no-retarget directive, pre-dispatch reauthorization, and persisted receipts.
- `apps/web/src/vnext/pages/business-development/BizDevBrief.tsx` and `BusinessDevelopmentPage.tsx` — five-section editor, citation inspector, refresh preview, immutable version history, and Draft with Meri.
- `apps/web/src/components/chat/meri-window.ts`, `apps/web/src/vnext/meri/meri-route-state.ts`, and `VNextMeriWorkspace.tsx` — one-shot fail-closed launch of a fresh prospect-scoped durable conversation through an addressable VNext handoff. Only the prospect UUID crosses the browser boundary; the server resolves and persists the authority-bearing scope.

## Brief schema and persistence review

Migration `20280927010000_business_development_phase4_brief` adds:

- `business_development_briefs`: one stable root per `(tenant_id, prospect_id)`, current-version pointer, title/status, creator, and timestamps.
- `business_development_brief_versions`: immutable append-only versions with source snapshot, snapshot/section hashes, exact section contract, author, idempotency operation/key/fingerprint, and timestamps.
- composite tenant-aware foreign keys that prevent a current-version pointer from crossing briefs or tenants;
- a unique logical version number per brief and tenant-scoped idempotency uniqueness;
- forced row-level security and tenant-isolation policies on both tables;
- application grants of `SELECT` and `INSERT`, but not `UPDATE` or `DELETE`, on saved versions.

Every saved version contains exactly these five sections:

1. `companyAndFirmImplication`
2. `verifiedEvidence`
3. `judgment`
4. `practicalAction`
5. `missingInformation`

Each section records `generated` or `edited` provenance and bounded citation indexes. Citation metadata separates `eventDate`, `sourceUpdatedAt` (the available publication/update value), and `retrievedAt`; an unavailable date stays null and is displayed as not supplied. User edits survive refresh: preview never writes, acceptance rebuilds against current evidence, and a concurrent version change produces a visible conflict rather than an overwrite.

## API and Meri contracts

All HTTP paths inherit the Phase 1 `standard_user` role floor and Phase 1 flag, then add the Phase 4 brief guard. `POST /api/business-development/brief/claim-check` also requires the independent claim-validation guard.

| Operation                          | Route or tool                                                                                                                                    | Key behavior                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Current brief                      | `GET /api/business-development/prospects/:prospectId/brief`                                                                                      | Returns the current authorized version or an honest null.                                                        |
| Initial version                    | `POST .../brief/versions`                                                                                                                        | Idempotent first saved version from the authorized dossier snapshot.                                             |
| Edited version                     | `PUT .../brief/versions`                                                                                                                         | Requires expected version and idempotency key; records edited provenance.                                        |
| Refresh preview/accept             | `GET .../brief/refresh-proposal`, `POST .../brief/refresh-accept`                                                                                | Preview is read-only; explicit acceptance is version-checked and preserves user edits by default.                |
| History                            | `GET .../brief/versions`, `GET .../brief/versions/:versionNumber`                                                                                | Lists and reads immutable saved versions.                                                                        |
| Citation inspection                | `GET .../brief/citations?index=`                                                                                                                 | Returns the saved citation and currently authorized source, or a typed changed/unavailable limitation.           |
| Deterministic claim check          | `POST /api/business-development/brief/claim-check`                                                                                               | Bounded exact identity/citation/amount/date/stage outcome; no semantic Jev result.                               |
| Meri context/evidence/brief/source | `get_business_development_context`, `get_business_development_evidence`, `get_business_development_brief`, `resolve_business_development_source` | Server derives scope; model cannot submit authority fields; provider payloads, notes, and contacts are excluded. |
| Meri save                          | `save_business_development_brief`                                                                                                                | Saves exactly five generated sections with deterministic idempotency; never sends outreach.                      |

The persisted scope contains prospect ID/name, optional canonical-organization ID, optional confirmed linked-client ID, and a server hash over the authority-bearing IDs. Prompts cannot retarget a conversation. Every legacy, V2, V3, and Hermes dispatch reauthorizes the stored scope before persisting a user turn or invoking a model. Tool handlers reauthorize it again immediately before reads or writes.

## Permission and privacy review

- Controller routes require an authenticated tenant context and `standard_user` or higher. Existing conflict/preference administration remains `user_admin` or `capiro_admin`; Phase 4 does not widen those permissions.
- Guessed, missing, inaccessible, and cross-tenant prospect/brief IDs return the existing safe not-found response. All feature-guard read failures also fail closed as the same bare 404.
- Every brief query uses the current tenant transaction plus an explicit tenant predicate. Database RLS is forced as a second boundary.
- Citation records are server-owned. An edit or Meri tool cannot inject a new citation, source date, source ID, or provider record.
- Meri receives bounded allowlisted evidence fields. Raw provider payloads, personal contact records, full internal notes, secrets, and unrestricted dossier text are not included.
- Phase 4 telemetry is restricted to low-cardinality operation/outcome/count/latency fields and does not log brief text, prompts, source passages, names, tenant/user/prospect identifiers, notes, or contacts.
- The brief workflow never initiates external communication. Existing email/outreach tools still require an explicit user request, the existing account/permission checks, and the existing approval path.

Review owner: repository implementation review. The repository deployment hold was explicitly released by the task owner on 2026-09-25; direct AWS CLI rollout completed at 2026-09-25T12:22:58.713Z and the VNext handoff hotfix completed at 2026-09-25T13:04:07.202Z.

## Feature flags and rollout order

All controls default to false and fail closed:

1. `businessDevelopment.brief.enabled` — brief API and UI.
2. `businessDevelopment.meriProspectTools.enabled` — prospect-scoped Meri tools and Draft with Meri.
3. `businessDevelopment.claimValidation.enabled` — deterministic claim-check endpoint only.

The web receives the corresponding `businessDevelopmentBrief`, `businessDevelopmentMeriProspectTools`, and `businessDevelopmentClaimValidation` booleans from `/api/me`. The Brief tab is not mounted and makes no query while its flag is off. Draft with Meri additionally requires the Meri-tools flag. The claim-validation flag has no automatic UI execution; it guards the explicit API contract until a reviewed assisted-validation presentation is added.

Rollout order is staging fixtures → authorized `capiro-internal` users → limited production cohort. Enable brief first, then Meri tools after the edit/version/source journey passes, and keep claim validation off until the deterministic outcomes and product presentation receive review. `BD-CLAIM` Jev remains dark regardless of these flags.

## Engagement actions and honest blocker

When a prospect has a confirmed linked client, the server checks that the current user may access that client and binds the existing `conversation.clientId`. The established client-scoped tools then remain available without Phase 4-specific storage or APIs: notes, tasks, meeting preparation, outreach lookup/drafting, and approved sending.

When a prospect has no confirmed linked client, client-scoped notes, meetings, tasks, or outreach cannot be attributed safely. The prospect conversation deliberately rejects an arbitrary client ID. The user must use the Phase 1 identity/link-or-convert flow first. A client-less `save_note` can still create a personal/conversation note, but it is not represented as a linked-client action.

## Claim validation boundary

The deterministic checker is intentionally limited. It can establish that the selected saved citation matches a bounded exact identifier, citation index, amount string, date, or stage. It does not decide semantic truth, company intent, opportunity likelihood, firm fit, or a person's official role. A mismatch returns a qualified or unsupported outcome and the actual bounded evidence; it never fills a gap from model knowledge.

The shared Phase 3 `BD-CLAIM` task remains dark. Its replay fixtures prove routing and exact-field rejection, not model accuracy. There is no approved human-reviewed evaluation set, so no application caller, targeted semantic repair, or visible Jev result is authorized in Phase 4. Provider timeout/Jev-unavailable behavior therefore cannot remove or degrade already supported saved content.

## Telemetry and operational limits

The service records privacy-safe Phase 4 operation outcomes and elapsed time for create/generate, edit/save, refresh preview/accept, citation resolution, and deterministic claim checks. Existing Meri tool execution telemetry already supplies tool name, success/error, and latency for the five new tools. Runtime scope failures are emitted as bounded authorization/scope-conflict outcomes without authority IDs. Existing API latency middleware supplies endpoint p95 inputs for the Phase 4 routes.

Dossier section status and coverage expose source retrieval availability/partial state. Brief version and idempotency conflicts remain durable application outcomes. Phase 3 Jev traces retain token and estimated-cost fields only when Jev is actually called. Phase 4 records no provider/Jev cost because generation uses the existing Meri runtime and semantic `BD-CLAIM` is dark; deriving a per-brief provider allocation would be misleading until the shared telemetry supports that attribution.

No success threshold is invented here. Product and reliability owners must establish baselines and pass/fail thresholds from the internal cohort before broader rollout.

## Verification

Local verification is the release gate while GitHub-hosted Actions are unavailable due the repository account's existing billing/spending-limit block.

Completed gates:

- API brief, telemetry, flag, scope, permission, persistence, Meri tool, conversation, and registration contracts: 12 suites / 245 tests passed.
- Meri orchestrator prompt plus read/write tool catalogs: 3 suites / 38 tests passed.
- Web Phase 4 launch/editor/scope tests and existing Phase 1–3 Business Development regressions: 7 files / 84 tests passed. The run emitted existing React `act(...)` and React Router future-flag warnings only; there were no failed assertions.
- The post-walkthrough VNext prospect-handoff hardening passed 48 targeted assertions across the window launch, route-state, Business Development, and Meri identity suites; the full web typecheck also passed.
- API TypeScript compile (`tsc --noEmit -p tsconfig.json`), full web typecheck, orchestrator typecheck, and shared-contract typecheck passed.
- A disposable PostgreSQL 16 database applied all 432 repository migrations from an empty schema, including the Phase 4 migration. The rollback-only two-tenant rehearsal then passed tenant-isolated reads/writes, fail-closed unset tenant context, cross-tenant insert/update denial, append-only version grants, idempotency uniqueness, and same-brief current-version foreign-key enforcement.
- Prettier check and `git diff --check` passed after the final implementation/documentation changes.
- Both redacted JSON examples parsed successfully.

Hermes delegation used the cost-effective `z-ai/glm-5.3` model with low reasoning, an 8,192-token response cap, a 40% warning, and a hard stop at 48% context. The UI implementation session peaked at 8.4582%, the independent completion audit at 7.1681%, and the final telemetry session at 4.9932%. Every worker exited after its bounded assignment; no session approached the requested 50% ceiling.

Two redacted, contract-shaped example briefs with resolvable public source traces are in `docs/verification/business-development-phase4/`:

- `example-brief-sam-identity.json` — exact SAM UEI/CAGE identity, missing-date honesty, and preserved edited action.
- `example-brief-usaspending-award.json` — exact USAspending award ID/amount/stage/performance dates and qualified firm-fit inference.

They are release-review fixtures based on public records already exercised during the authorized Phase 2 acceptance, not production exports or assertions of exhaustive provider coverage.

## Signed-in walkthrough and captured evidence

The signed-in AWS walkthrough was completed after the deployment hold was released. Browser captures were retained inline with the release task rather than written into the repository; the durable observed values and infrastructure evidence are recorded here and in `docs/verification/business-development-phase4/release-evidence-2026-09-25.json`.

- On unresolved synthetic prospect `1da7f223-6e38-4dd6-8c71-111a9d0966e1` (`SATCOM DIRECT`), the workflow created an honest five-section Version 1 with missing evidence represented as missing and no fabricated citations.
- Draft with Meri created durable conversation `9002db18-ef61-4370-84c9-b8c6a81bfb04`, visibly resolved the receipt to `PROSPECT · SATCOM DIRECT`, called the bounded context/evidence/brief tools, and proposed the approval-gated brief save. The proposal was not approved and no outreach was sent.
- An edited title was saved as immutable Version 2 while Version 1 remained in history. Refresh Preview then reported no evidence-backed text change and offered explicit Replace/Keep-my-edits choices; cancelling left the saved edit untouched.
- On exact-UEI prospect `88b1875d-e047-44ff-a7ab-1870dbe47407` (`SATCOM DIRECT GOVERNMENT, LLC`), the initial brief used 12 exact-identifier dossier items. Citation 3 resolved to USAspending award `HC101323FF361`, with event, publication/update, and retrieval dates represented separately and the publication/update date honestly shown as not supplied.
- Missing evidence and ambiguous identity were exercised live. The claim-validation flag stayed false. Stale version, double-save, cross-tenant, immutability, and fail-closed tenant-context cases were covered by automated tests plus the two-tenant PostgreSQL rehearsal.
- No verified walkthrough prospect had a confirmed linked client, so the linked-client action step remained intentionally unavailable. No arbitrary link/client was fabricated. This is the documented Phase 1 prerequisite, not a failed Phase 4 capability.
- No external communication was sent. Meri explicitly preserved the approval gate, and the live proposal was left unapproved.

The walkthrough exposed one real VNext navigation defect: Draft with Meri dispatched the legacy in-page event even though the listener exists on `/meri`. Pull request 1811 replaced that path with an addressable, UUID-validated prospect handoff, added the targeted regression coverage, and was deployed before final acceptance.

## Rollout and rollback

Completed rollout:

1. The additive migration ran with `capiro-dev-api-admin-migrate:72`; task `b72bf0c40dd7490b83c4c6102ead4b84` exited 0 after confirming all 432 migrations and no pending migration.
2. Pull request 1806 merged as `30a9ab33458fe3b2d6b76b73c00c773979b8cebb`. AWS CLI deployed API `:458`, Meri orchestrator `:82`, and web `:140` by immutable ECR digest.
3. Service health, task-definition environment SHAs, running-task digests, and the migration result were verified before flags changed.
4. `businessDevelopment.brief.enabled=true` and `businessDevelopment.meriProspectTools.enabled=true` were committed only for `capiro-internal`; `businessDevelopment.claimValidation.enabled=false` was re-read and retained.
5. The signed-in brief/source/edit/history/Meri walkthrough ran. Its navigation finding was fixed in pull request 1811, merged as `4e30ad8f05ff4afcd0a983b46b424dda05d6d505`, and the exact ARM64 web image was deployed by digest as `capiro-dev-web:141`.
6. Post-hotfix health showed API 2/2, orchestrator 1/1, and web 1/1 healthy with completed ECS rollouts. `/healthz` returned 200 `ok`, and the web runtime configuration reported the final release SHA.
7. Semantic Phase 3 `BD-CLAIM` Jev remained dark and no external communication was sent.

Rollback:

1. Disable the Meri-tools and brief flags (and claim validation if ever enabled); routes and UI fail closed immediately.
2. Restore the prior API/web ECS task definitions if an application rollback is required.
3. Retain the additive brief tables, immutable saved versions, evidence snapshots, and audit history. Do not destructively reverse user-authored data.
4. Phase 1 prospects, Phase 2 dossiers, and Phase 3 shadow traces remain intact and independently flag-controlled.

Release evidence:

| Item                                | Released value                                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial Phase 4 PR / SHA            | [#1806](https://github.com/neo-capiro/capirov2/pull/1806) / `30a9ab33458fe3b2d6b76b73c00c773979b8cebb`                                                                                                                                               |
| VNext handoff hotfix PR / final SHA | [#1811](https://github.com/neo-capiro/capirov2/pull/1811) / `4e30ad8f05ff4afcd0a983b46b424dda05d6d505`                                                                                                                                               |
| Current task definitions            | API `capiro-dev-api:458`; orchestrator `capiro-dev-meriv2-orchestrator:82`; web `capiro-dev-web:141`; migration `capiro-dev-api-admin-migrate:72`                                                                                                    |
| Current image digests               | API `sha256:3e74f297b95bd2fa37ba8cbe42523241a42fc774260b1c357e60e13f01fb9c19`; orchestrator `sha256:f394484708b633f4bacee9361486bbad50190f616b0cdae3b84e3ad7c118d4cb`; web `sha256:5760d0c87fe979bc02fd9c3409ecc7870c945653736540f065a6c8c4d64cb230` |
| Immediate rollback revisions        | API `:457`; orchestrator `:81`; web `:140` (the pre-Phase-4 web baseline remains `:139`)                                                                                                                                                             |
| Migration                           | Task `b72bf0c40dd7490b83c4c6102ead4b84`, exit code 0                                                                                                                                                                                                 |
| Flags                               | brief `true`; Meri prospect tools `true`; claim validation `false`, tenant `capiro-internal`                                                                                                                                                         |
| Deployment timestamps               | Initial rollout `2026-09-25T12:22:58.713Z`; final web hotfix `2026-09-25T13:04:07.202Z`                                                                                                                                                              |

CloudWatch contained no error-level API, orchestrator, or web events after the final hotfix completed. Between the initial rollout and hotfix, two isolated API errors occurred under unrelated concurrent tool/scrape traffic: one expired Prisma transaction and one upstream `fetch failed`; neither involved a Phase 4 route or left a continuing service-health issue. GitHub-hosted Actions could not start because of the repository account's billing/spending-limit block, so the documented local test, typecheck, migration rehearsal, and AWS health gates were used.

## Explicitly deferred integrations

- Phase 3 semantic `BD-CLAIM` Jev validation and targeted semantic repair, pending an approved human-reviewed evaluation set and release gate.
- People Data Labs company/people enrichment and any bulk people ingestion.
- Automatic external outreach, automatic client conversion, automatic identity merge, and continuous opportunity monitoring.
- Client-scoped action execution for an unlinked prospect; the existing link/convert prerequisite is intentional.
