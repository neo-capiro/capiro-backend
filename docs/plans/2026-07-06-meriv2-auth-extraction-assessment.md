# MeriV2 auth extraction — assessment + adoption plan (CTO decision required)

Date: 2026-07-06
Status: **Assessment complete — adoption BLOCKED on CTO sign-off (plan §9.1 / DECISIONS D8).**
Author: Claude (MeriV2 gap-closing drive)

## Why this is a document and not a code PR

Every other MeriV2 readiness gap in this drive shipped as a held PR. Auth
extraction did not, for two reasons that are governance/design, not effort:

1. **Explicit CTO gate.** The architecture plan (`2026-06-29-...` §9.1) and
   `2026-06-30-meriv2-DECISIONS.md` (D8) both state: the orchestrator's
   tenant/client scoping WRAPS Clerk/tenant-mw/JWT and **must not be moved or
   reimplemented without CTO go**. Auth is the highest-blast-radius code in the
   platform — a regression logs every user out or, worse, crosses tenants.
2. **It is not a mechanical extraction.** There are TWO different auth shapes
   today (below). Unifying them requires a real design decision about the
   canonical `TenantContext`, which is the CTO's call — not something to guess.

This doc does the part an agent CAN do safely: prove feasibility, specify the
canonical module, and lay out a low-risk, reviewable adoption sequence, so the
flip is a go/no-go decision with the work already scoped.

## Current state — three services, two auth shapes

| Service | Auth pieces | Context shape |
|---|---|---|
| `apps/api` | `auth/clerk.service.ts`, `tenant/tenant-context.middleware.ts` (+ store, decorator), `auth/roles.guard.ts` | **FULL** `TenantContext` (`@capiro/shared`): Clerk verify **+ membership lookup against the tenant/user tables** → real Capiro `userId`, role, org. |
| `apps/workspace` | `auth/{clerk.service,tenant.guard,current-tenant.decorator,tenant-context}.ts` | **NARROW** `WorkspaceTenantContext`: Clerk verify only; trusts the JWT `tenantId` claim; **never synthesizes a Capiro userId**. |
| `apps/meriv2-orchestrator` | same four files (cloned from workspace) | **NARROW** `OrchestratorTenantContext`: identical intent to workspace; per-user Capiro id is resolved later at the data-adapter boundary (`get_client_context`). |

Feasibility diffs (this drive):
- `apps/workspace` vs `apps/meriv2-orchestrator` auth files: **structurally identical**, differing only in (a) the context type NAME
  (`WorkspaceTenantContext` vs `OrchestratorTenantContext`), (b) comments. The
  Clerk-verify guard + decorator logic is the same.
- `apps/api` auth is **genuinely different**: it does a membership DB lookup and
  produces the full `TenantContext`. It is NOT the same code with a renamed type.

## The design decision the CTO must make

**What is the canonical shared auth module?** Two coherent options:

- **Option N (narrow, low-risk):** extract ONE shared "Clerk-verify → narrow
  tenant context" guard/decorator/service used by `orchestrator` + `workspace`
  only. `apps/api` keeps its richer membership-backed middleware untouched.
  De-duplicates the two clones; leaves the hard service alone. Does NOT achieve
  a single platform-wide auth.
- **Option F (full, higher-risk):** one canonical auth for all three, which
  means reconciling narrow vs full — either the orchestrator/workspace start
  doing the membership lookup (behavior change: they'd synthesize a Capiro
  userId they currently, deliberately, do not — this interacts with SC0.7
  scoping parity), or apps/api's middleware is refactored to compose a shared
  Clerk-verify core + a separate membership-enrich step.

Recommendation: **Option N first** (mechanical, reversible, no context-shape
change), with Option F as a later, separately-gated step if a single platform
auth is actually wanted. Option N is what the sections below scope.

## Option N adoption sequence (each step independently revertible)

1. **Create the shared module** (`packages/shared` or a new `@capiro/auth`):
   `verifyClerkAndBuildNarrowContext()` + a Nest `TenantGuard` + a
   `@CurrentTenant()` decorator + the narrow `TenantContext` type. Byte-for-byte
   the orchestrator's current behavior. Ship with unit tests (valid/invalid/
   missing JWT, cross-tenant token → 401/403). **No app imports it yet.**
2. **Adopt in `apps/meriv2-orchestrator` ONLY** (lowest blast radius — newest
   service, full jest suite green in this drive). Swap its 4 auth files for the
   shared import; run the 58-test suite + a live `/meri-api/health` 200 +
   `/meri-api/tools` 401 check. Bake.
3. **Adopt in `apps/workspace`.** Same swap; verify a live in-editor request +
   generate path. Bake. (Higher risk: workspace is live for real users.)
4. **STOP.** `apps/api` (Option F) is a separate decision + PR; do not fold it in.

Each step is a small PR gated on the CTO's go; step 1 is safe to author now
(dead code until step 2), steps 2-4 rewire live auth and are the gated flips.

## Risks / verification per step
- **Blast radius:** an auth regression is a login outage or a cross-tenant leak.
  Mitigation: adopt one service per PR, cheapest-first; keep the old files one
  git revert away; verify with the SC0.7 cross-tenant token test each time.
- **SC0.7 parity:** Option N must NOT change what rows a (user, tenant) sees.
  The narrow context is unchanged, so this holds by construction — but the
  cross-tenant parity test must be re-run after each adoption.
- **No `clerkUserId=pending:<id>` synthesis** (plan §9.1) — the shared module
  must preserve the current "trust the verified claim, never fake an id" rule.

## What is NOT blocked / already done
The orchestrator already imports `@capiro/shared` for `TenantRole`/`ROLE_RANK`/
the full `TenantContext` type — so the shared package is already a valid home
for auth. Nothing else in the MeriV2 migration depends on this extraction; it is
purely a code-duplication cleanup, which is why it was safe to leave for last.

## Decision requested
Approve **Option N** (and authorize step 1 + the per-service adoption PRs), or
choose **Option F** (and own the narrow-vs-full context reconciliation). Until
then, the three services keep their own auth — which is correct and safe, just
duplicated.
