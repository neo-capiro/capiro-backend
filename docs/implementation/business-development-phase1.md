# Portfolio Business Development Phase 1

Implementation date: 2026-09-24

## Scope and reuse

This release adds a firm-owned prospect pipeline at `Portfolio → Business Development`. It reuses the authenticated tenant context, role guard, tenant feature-flag settings, canonical organization registry, `ClientsService` entitlement and creation rules, audit log, Portfolio route conventions, and existing Capiro UI primitives. It makes no new provider calls and does not add discovery, polling, alerts, prospect briefs, outreach, SAM/LDA workflows, or People Data Labs.

The module is default-off through `businessDevelopment.enabled`. Both `/api/me` navigation and page rendering fail closed, and every `/api/business-development/*` route independently returns the same not-found response unless the calling tenant is enabled.

## Persistence and isolation

Migration `20280924010000_business_development_phase1` adds:

- `business_development_prospects`, including nullable confirmed canonical identity, owner, the eight Phase 1 stages, active/dismissed state, conflict/exclusion, next action, watch request, and client conversion link.
- `business_development_prospect_activity` for notes and durable workflow history.
- `business_development_preferences` for small firm-owned preference arrays.
- Nullable `clients.canonical_entity_id` for exact, reviewed same-firm identity reuse.

The three new tenant tables use `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, explicit tenant policies, and app-role grants. Service queries also carry explicit tenant predicates. Owner assignment requires an active membership in the calling tenant. Canonical search exposes only active global-public organizations and the calling tenant's private organizations. Manual prospects never create or mutate a shared organization.

Partial unique indexes enforce one prospect per `(tenant, confirmed canonical organization)`, one prospect link per client, and one client per `(tenant, confirmed canonical organization)`. Unresolved names and domains are deliberately not unique. A confirmed duplicate opens the existing active record or restores its dismissed record; pre-save same-firm hints let users review ambiguous manual duplicates without silently merging them.

## Permissions

| Capability | Standard user | Firm/Capiro admin |
| --- | --- | --- |
| Read/filter/search the firm pipeline | Yes | Yes |
| Create/edit/assign/stage/note/watch/dismiss/restore | Yes | Yes |
| Link or convert a prospect | Yes | Yes |
| Change conflict/exclusion override | No | Yes |
| Save firm preferences | No | Yes |

Identity, stage, owner, conflict/exclusion, dismissal/restore, watch, and conversion mutations write the existing audit log. Prospect activity keeps notes and workflow history through dismissal and conversion. Conflict reasons and note bodies remain tenant-private and are never copied to canonical organization records.

## Conversion transaction

Conversion locks the tenant-owned prospect row, then either validates a selected same-tenant non-archived client, reuses the exact confirmed canonical client, or invokes `ClientsService.createInTransaction`. The client entitlement check, client write, prospect link, activity, and audit all commit or roll back together. A selected unconfirmed client receives the prospect's reviewed canonical identity; a mismatched identity or already-linked client returns a structured same-firm review conflict. Repeated or concurrent conversion of the same prospect returns one client and creates no orphan. Setting the stage to `Won` never converts by itself. Post-create resolution/prepopulation enrichment starts only after commit.

## API surface

The flag-gated `/api/business-development` controller provides prospect list/get/create/update, pre-save and saved-record duplicate hints, notes/history, conflict, dismiss/restore, identity confirmation, link/conversion, preferences, active member options, bounded canonical organization search, and bounded same-tenant client search.

## Verification

- Prisma schema generation and validation: pass.
- Business Development API suites: 5 suites, 104 tests after preference-bound coverage.
- Client service regression: 2 suites, 53 tests.
- Focused web/Portfolio/navigation contracts: 5 files, 73 tests.
- Disposable PostgreSQL acceptance: concurrent confirmed create, pre-save duplicate review, identity preservation, selected-client canonical stamping, conversion idempotence, and structured same-client conflict pass.
- App-role RLS rehearsal: tenant A/B read and write isolation plus missing-tenant fail-closed behavior pass.
- Web production build and full web TypeScript check: pass after the normal prerequisite build of `@capiro/strategy-verifier`.
- API changed-file TypeScript diagnostics: zero. The repo-wide API check retains unrelated baseline diagnostics documented in the PR.
- ESLint is configured but is not installed in the current workspace dependency graph; no dependencies or lockfiles were changed to mask that repository issue.

## Release and rollback

Deploy only the exact merged `main` commit through the repository AWS CLI release workflow. Run the additive migration before service cutover. Keep the flag off globally and enable only the named internal smoke tenant after API/web health checks.

Smoke path: manual add → duplicate review/save → assign/change stage → note/next action → watch request → conflict/exclusion → dismiss/restore → link or convert client → reload/back/narrow-layout verification.

Rollback is non-destructive: disable `businessDevelopment.enabled`, then return API/web services to the last healthy task definitions if needed. Keep the additive schema, prospects, activity, and audit history. Deployment commit, image digests, migration task/log, resulting task definitions, health checks, internal flag state, browser evidence, and rollback task definitions are recorded in the pull request and final delivery report.
