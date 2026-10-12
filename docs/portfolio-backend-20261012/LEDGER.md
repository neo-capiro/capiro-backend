# Portfolio / Modules backend dependency and ownership ledger

Established before source edits, 2026-10-12. Source-only authority: isolated
`codex/portfolio-backend-sender-20261012`, based on main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. Original checkout/branches remain intact.
No merge, deployment, provider send, paid generation, database migration or customer
mutation is authorized. Deployment preparation belongs to dot.

## Instructions and source evidence

No `AGENTS.md`, `.agents/skills`, or `CLAUDE.md` exists in this backend checkout or
refreshed main; `/workspace/.agents` is empty. Read and apply the supplied frontend
`AGENTS.md` and `docs/IMPLEMENTATION-STANDARDS.md` for canonical ownership, thin
entry points, bounded modules and meaningful verification. These do not transfer
frontend ownership to this task.

Read Modules handover at `50155cbbf0e4df1eecba22cbfc9b2c35bff87e0a` and Portfolio
continuation handover at `c953bc08a9cabc6e38fdacd019017d2e891a3284`. Portfolio PR6
source is published at `abaeab37b36d60b3e5185755e1b2c9169d7c92f3`; this supersedes
the continuation handover's missing-source claims. Read its exact Email Sender,
Quick Log, Prospect Files, Ordered Owners and Objective Navigation contract reviews
under `docs/portfolio-31/handover-2026-10-11/`.

All remote branch heads refreshed. Read-only GitHub PR metadata reports the seven
preserved backend candidates open/draft and currently mergeable, including PR2364
and PR2365 (contrary to earlier conflict reports). Mergeability is not acceptance.
Exact refs, changed paths and pairwise intersections are in `dependency-paths.json`.

## Dependency and implementation allocation

| Contract | Canonical source owner / dependencies | This task's disposition |
| --- | --- | --- |
| Exact sender | Engagement single-mail DTO/service; existing `findCampaignSendConnection`, mail dispatcher, provider adapters and actor signature | Implement additive selected connection and minimal mailbox projection. Preserve PR2364 reply preflight and PR2381 attachment authorization in this isolated combined candidate. No credentials in projection; exact selection never falls back. |
| Facilities | PR2373 at `6e5774a`, revision helper, reviewed route, inline/nightly CAS | Reconcile in a separate main-based candidate. Preserve Cleanup PR2392 lifecycle changes in the overlapping geocode script without importing the unrelated Cleanup stack. No migration. Native concurrency remains unqualified. |
| Objective persistence | PR2362 at `72bfea4`, existing drafts/revisions, request keys, client walls | Reuse; no second objective service or migration. Navigation is a separate bounded-reference contract. |
| Prospect stages | PR2365 at `fd6ed6c` | Preserve; existing-record mapping and migration allocation remain open. No stage/conversion rewrite here. |
| Prospect contacts | PR2371 at `6c6f88e` | Preserve unregistered candidate; conversion carry-over and migration allocation remain open. |
| Quick log | Core `clients/client-activity.service.ts`; Engagement `createTask`; Strategy `planner.saveTask` | Specify durable orchestration and recovery against these resources; do not create a second task service. Task audience and date semantics require decisions. |
| Prospect Files/Workspace | Engagement attachment presign/confirm/list/readiness/ACL; Workspace `WsDraft`/`WsDocVersion`; BD conversion | Specify authoritative tenant/prospect binding and conversion visibility before allocating migration source. Free-text client/draft names cannot establish ownership. |
| Ordered owners | `clients/client-account-owner.service.ts`, `client-team.service.ts`, `clients.account_owner_user_id` | Specify atomic versioned replacement with legacy synchronization; no new free-text role convention. |
| Newsletter to Outreach | Workspace saved drafts/doc versions; Engagement versioned Outreach commands | Exact saved revision bridge only; no generation/send enablement. |
| Calendar effective dates | Intelligence rule/source repositories and existing calendar source feeds | Dated source contract remains required. Publication/comment dates are not effective dates. |
| Engagement aggregates | Existing Engagement overview/read models | Audience and completeness semantics must precede extension. |

Shared frontend authentication/client scope and Intel receipt validation belong to
the frontend owner. Existing Intel normalization/rejection and audited one-hour HQ
impersonation are non-gaps; no replacement endpoints or expanded authority. Meri
preferences belong to the new greenfield contract owner. No edits in either repo.

## Sender design and review boundaries

Keep DTO/controller changes additive and thin. Reuse the existing authorized
connection resolver. A small mailbox policy/projection module owns the shared
send-capable query and safe returned fields; it must not become another integration
service. New messages may omit the selector for legacy selection behavior. Replies
must first pass the existing owner predicate, then resolve their originating
connection; an explicit different connection is refused before bytes/provider work.
Missing originating connection fails closed. Recheck reply ownership/connection at
persistence. Actual provider dispatch, local From, connection and receipt must agree.

The existing signature is actor-level, not per-mailbox. Continue to sanitize and
append that explicit actor preference; disclose that policy in the receipt rather
than inventing per-mailbox signatures or using the actor email as the sender.
Do not overwrite provider-sync-owned message fields during deduplication.

EngagementService/controller are existing large modules. This addition stays at
their orchestration/transport boundaries; query/projection policy lives in a small
cohesive module. Broader extraction is outside the bounded task. Review negative
paths and the exact resulting diff after implementation, separately from test runs.

Focused synthetic checks: mailbox B on both providers; foreign/disconnected/tokenless
B with zero fallback; thread A vs B and removed/foreign thread; attachment refusal
before byte/provider calls; actor signature sanitization/opt-out; provider ambiguity
without retry/persistence; DTO wire compatibility; safe mailbox projection. Run
retained reply, attachment, provider and thread-dedup suites on the exact candidate.
Report type/build/tooling failures and live gates separately.

## Final candidate intersections

`candidate-paths.json` recomputes actual sender candidate intersections after code
and route-manifest generation. The sender has **one Cleanup overlap**:
`apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json`. Comparing
manifest semantics without `sourceLine`, Cleanup changes no routes relative to main;
this sender adds exactly `GET /api/engagement/mail/mailboxes` with no other semantic
changes. Regenerate that artifact from combined source during future integration;
do not select one side by overwriting another owner's generated evidence. This
small overlap does not make the candidate dependent on Cleanup's release gate.

Sender has no facility/stage/contact/objective changed-path intersections. The
Engagement overlaps are the intentionally preserved prerequisites; both original
PR branches remain unchanged. The facility reconciliation branch contains only
PR2373's eight source/document paths plus new qualification documents. Its source
is unchanged from PR2373, with the complete current Cleanup lifecycle prerequisite.
