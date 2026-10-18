# Core receiving scope: Modules hub and Settings facts (2026-10-18)

This is a **source receiving map**, not a runtime activation or a commitment to
the example values in the design. It is based on frontend draft
[PR #94](https://github.com/neo-capiro/capiro-frontend/pull/94) at
`e1de3f1d41f508629a79c198a21b71103e17c245` (base PR #92
`271a267da93aa952a89b208d1f42eed0ffb080c2`), particularly
`docs/modules-settings/FIGMA-3.4-DESKTOP-AUDIT-20261018.md`, and on Core
source base `b40971b1f8de888687a8fb92fbdf4ff653fe10d3` (PR #86).
The active chat, memory and retained-read receiving lanes remain higher priority.

## Existing source and exact gaps

| Requested fact | Current authoritative source/route | Receiving disposition |
| --- | --- | --- |
| Available client profiles in `/modules` scope | Core `GET /api/clients?includeArchived=false` (`apps/api/src/clients/clients.controller.ts:334`); preview-native mode restricts the returned set to visible client IDs. PR #94 counts this response. | **Present for available profiles only.** It must not be relabeled a full-firm profile count. |
| Seven Modules card metrics (Engagement, Planner, Workspace, Strategies, Directory, Intelligence, Research Portfolios) | Each card is a navigation descriptor in frontend `shared/shell/module-catalog.ts`; `ModuleHub.tsx` has no metric query. Core `GET /api/engagement/outreach` is a user-owned, capped list (`engagement.service.ts:2609`); `GET /api/research-portfolios` returns a grant-scoped page of at most 50 and a cursor, with no total (`research-portfolios.service.ts:70-111`); `GET /api/intelligence/portfolio-summary` returns Portfolio statistics, including actor-owned meetings, not seven Modules totals (`intelligence-portfolio-summary.ts`). Planner and Strategies have `apps/api-strategy` owners; Workspace has `apps/workspace`; Directory and Intelligence have their own source owners. | **Unavailable as firm-wide card metrics.** The Figma numbers are examples. None of these list/page or Portfolio routes proves a tenant-wide module count. No count should be derived from one page or another scope. Engagement remains Outreach-only in PR #94. Research Portfolios are separate from client profiles. |
| Pending invitation and inviter | Core `GET /api/tenant-admin/team/invitations` is `user_admin` guarded and calls `TenantAdminService.listPendingInvitations` (`tenant-admin.controller.ts:178`, `tenant-admin.service.ts:198`). It reads Clerk's pending organization invitations and returns `id`, `email`, `role`, `createdAt`, `expiresAt`. The installed Clerk `OrganizationInvitation` resource has no inviter field. `createOrganizationInvitation` accepts `inviterUserId`, but this Core call does not pass it. `TenantMembership.invitedBy` belongs to memberships, not pending invitations. | **Pending state present; inviter unavailable.** Existing and out-of-band Clerk invitations cannot be assigned an inviter from email, role, timestamps, membership data or the current response. The UI can show a blank/unknown inviter until a trusted receipt exists. |
| Billing capacity, status and period | Core `GET /api/billing/state` gives minimal posture to authenticated roles. `GET /api/billing/summary` is billing-admin guarded (`billing.controller.ts:20-49`, `billing-admin.guard.ts`) and returns slots, used slots, status, list unit price, LLM usage and current period end (`billing.service.ts:78-127`, `packages/shared/src/index.ts:758`). | **Present for those fields.** `slots × pricePerSlotUsd` is only a capacity list price per month, as PR #94 now labels it; it is not the next charge. |
| Plan terms and cancellation window | The Tenant row has `priceLockExpiresAt`, `currentPeriodEnd`, `canceledAt` and billing status (`apps/api/prisma/schema.prisma`); the single Stripe writer in `apps/onboard-api/src/billing/billing.service.ts` stamps a 12-month *price lock* and syncs subscription status. | **Unavailable.** A price lock is not a 12-month contract term. Period end and canceled timestamp do not establish a 30-day cancellation window or effective cancellation date. A governing agreement/policy source and its current version are required. |
| Payment method, invoice destination and invoice rows | Billing mutations and Stripe access are owned by `apps/onboard-api`. `POST /onboard-api/billing/portal` creates a hosted Stripe portal session for a tenant-bound customer; `POST /onboard-api/billing/checkout` starts hosted checkout. Core `apps/api` intentionally keeps read-only minimal billing views and no Stripe client. | **Unavailable in the frontend-safe GET contracts.** The portal can show provider facts to an authorized billing admin. No payment method last four, invoice delivery email or invoice rows should be inferred from the customer ID, current period end, list price, or usage. |
| Contract signer | No signer identity, signing receipt or agreement version is present in the Core Tenant billing fields or the checked billing routes. | **Unavailable.** Do not equate the Stripe customer email or a billing admin with the legal signer. |

## Smallest read contracts to receive after product decisions

These are proposals for owners to review, not implemented routes or frozen
schemas. Every route must use a server-established tenant/actor; a `clientId`
query is only a scope hint and must pass the owner's visibility check.

1. **Modules:** first name the seven metrics, their units, status filters,
   time windows, tenant-versus-actor visibility, client-scope behavior, and
   empty/unavailable presentation. Each module owner then supplies a bounded,
   tenant-scoped aggregate instead of asking the frontend to count a paginated
   list. An optional composed hub read may return an explicit metric ID,
   `scope`, `asOf`, and either a measured value or an unavailable state for
   each card; it must not turn a failed owner read into zero. Reuse the existing
   client visibility rule for selectable profile counts. The Research Portfolio
   owner must decide whether the metric is user-granted portfolios or something
   else; a firm total is a different authorization decision.
2. **Team:** extend the existing admin-only invitation read with a nullable
   inviter display fact only after Core captures the authenticated actor with
   the Clerk invitation ID on create and resend, and proves the mapping survives
   retries, revocation and replacement. Resolve the display identity inside
   the tenant boundary. Return `null` for historical, out-of-band, deleted or
   unprovable inviters. Coordinate the response schema and frontend change;
   never guess from the invitee's email or a later membership row. The local
   receipt's storage and migration ID require the shared allocation review.
3. **Billing provider details:** preserve `GET /api/billing/state` as minimal
   posture and keep the admin guard on summary. If an in-app read is selected,
   `apps/onboard-api` is the candidate Stripe-bound owner for a separate
   billing-admin-only, tenant/customer-bound, paginated read of safe payment
   method summary, invoice delivery setting and invoice rows. Each field needs
   its exact Stripe object, null behavior and freshness rule; a provider
   failure must be unavailable, not an empty invoice history. Keep card/bank
   secrets, full account numbers and hosted mutation flows out of the response.
4. **Commercial terms and signer:** name the governing agreement/terms owner,
   signer verification source, effective version, cancellation policy and
   amendment history before defining an endpoint. Neither the current Stripe
   subscription projection nor the 12-month price-lock timestamp supplies
   these facts. Terms and signer should stay unavailable until that source is
   chosen and an authorized read contract is reviewed.

No source mutation, schema migration, Stripe call, credential, live SQL or
deployment follows from this map. Runtime qualification and live readback are
separate work after a reviewed contract exists.
