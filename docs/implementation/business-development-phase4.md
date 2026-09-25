# Business Development Phase 4 — Meri prospect briefs and firm workflow

Date: 2026-09-25

Status: implementation complete and locally verified. Merge, staging walkthrough, screenshots, and direct AWS CLI deployment are pending the active repository deployment hold. All Phase 4 flags remain default-off. This record must be updated with immutable release evidence before the phase is declared deployed.

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
- `apps/web/src/components/chat/meri-prompt.ts` and `useMeriChatController.ts` — one-shot fail-closed launch of a fresh prospect-scoped durable conversation.

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

Review owner: repository implementation review. Final release approval owner and timestamp will be recorded after the deployment hold is released.

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
- API TypeScript compile (`tsc --noEmit -p tsconfig.json`), full web typecheck, orchestrator typecheck, and shared-contract typecheck passed.
- A disposable PostgreSQL 16 database applied all 432 repository migrations from an empty schema, including the Phase 4 migration. The rollback-only two-tenant rehearsal then passed tenant-isolated reads/writes, fail-closed unset tenant context, cross-tenant insert/update denial, append-only version grants, idempotency uniqueness, and same-brief current-version foreign-key enforcement.
- Prettier check and `git diff --check` passed after the final implementation/documentation changes.
- Both redacted JSON examples parsed successfully.

Hermes delegation used the cost-effective `z-ai/glm-5.3` model with low reasoning, an 8,192-token response cap, a 40% warning, and a hard stop at 48% context. The UI implementation session peaked at 8.4582%, the independent completion audit at 7.1681%, and the final telemetry session at 4.9932%. Every worker exited after its bounded assignment; no session approached the requested 50% ceiling.

Two redacted, contract-shaped example briefs with resolvable public source traces are in `docs/verification/business-development-phase4/`:

- `example-brief-sam-identity.json` — exact SAM UEI/CAGE identity, missing-date honesty, and preserved edited action.
- `example-brief-usaspending-award.json` — exact USAspending award ID/amount/stage/performance dates and qualified firm-fit inference.

They are release-review fixtures based on public records already exercised during the authorized Phase 2 acceptance, not production exports or assertions of exhaustive provider coverage.

## Staging walkthrough and screenshots

Pending the active deployment hold. After release, record the signed-in walkthrough for:

1. open an authorized prospect and its dossier;
2. draft with Meri and confirm the visible prospect receipt;
3. inspect a citation with separate event/source-update/retrieval dates;
4. edit and save, inspect immutable history, and preview/accept a refresh without losing edits;
5. ask a grounded follow-up in the same scope;
6. create/link an allowed action for a confirmed linked client;
7. request an outreach draft and confirm no send occurs without the existing approval;
8. exercise missing source, ambiguous identity, disabled Jev, stale prospect scope, stale version, double-save, and cross-tenant denial.

Screenshot paths, observed values, API/task-definition revisions, image digests, migration result, flag state, and CloudWatch/log checks will be added here after the direct AWS CLI deployment.

## Rollout and rollback

Rollout:

1. Apply the additive migration with the API admin-migrate task.
2. Deploy API and web images built from the merged GitHub `main` SHA using AWS CLI.
3. Leave all three Phase 4 flags off; verify service health and migration state.
4. Enable `businessDevelopment.brief.enabled` for `capiro-internal` and complete the brief/source/edit/history walkthrough.
5. Enable `businessDevelopment.meriProspectTools.enabled` for the same tenant and complete scope/follow-up/action checks.
6. Keep `businessDevelopment.claimValidation.enabled=false` until reviewed; keep Phase 3 `BD-CLAIM` Jev dark.

Rollback:

1. Disable the Meri-tools and brief flags (and claim validation if ever enabled); routes and UI fail closed immediately.
2. Restore the prior API/web ECS task definitions if an application rollback is required.
3. Retain the additive brief tables, immutable saved versions, evidence snapshots, and audit history. Do not destructively reverse user-authored data.
4. Phase 1 prospects, Phase 2 dossiers, and Phase 3 shadow traces remain intact and independently flag-controlled.

Release owner, merged SHA, PR, task definitions, image digests, and exact rollback revisions remain pending the deployment-hold release.

## Explicitly deferred integrations

- Phase 3 semantic `BD-CLAIM` Jev validation and targeted semantic repair, pending an approved human-reviewed evaluation set and release gate.
- People Data Labs company/people enrichment and any bulk people ingestion.
- Automatic external outreach, automatic client conversion, automatic identity merge, and continuous opportunity monitoring.
- Client-scoped action execution for an unlinked prospect; the existing link/convert prerequisite is intentional.
