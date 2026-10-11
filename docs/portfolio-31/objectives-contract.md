# Standalone client Objectives contract candidate

Base: capirov2 `fd8765ec01d292013758606204f2c9d886cd31c1`. Owner: Portfolio
implementation branch. Cleanup1 confirmed these paths do not overlap its work.
This is backend-only preparation; migration deployment and live integration
remain unapproved/unrun. The independent frontend repository is being clarified.

Responsibilities: a small Nest controller validates transport; Objective rules
normalize drafts and validate readiness; the service owns tenant/client scope,
owner membership, optimistic concurrency and atomic revision persistence.
Prisma owns storage through the existing tenant-scoped transaction. No new
authentication, CORS, billing, Meri loop or strategy engine is introduced.

The user confirmed on 10 October 2026 that readiness requires only four fields:
`outcome`, `governmentProblem`, `askType`, `minimumWin`. Optional `limits` and
owner assignment do not add readiness requirements. Ask types map exactly to
Figma: funding, policy_authority, both, protect_funding, meri_propose.
Draft fields may be empty. The server trims text and returns the four-field
checklist. Text is bounded; no invented semantic scoring or outcome-rewording
model is used. `meri_propose` records the selected answer, without calling Meri.

Routes are under `/api/clients/:clientId/objectives`. GET lists nondeleted
records; POST creates a draft. GET/PATCH/DELETE with `?objectiveId=<uuid>` read,
update or soft-delete one record. POST `/transition?objectiveId=<uuid>` accepts
`request_review` or `confirm_ready`. Updates/deletion/transitions require
`expectedVersion`; stale writes return409. All routes require standard_user
and the existing authenticated active tenant context. Foreign/archived clients
and foreign/client-mismatched Objectives return404. Assigned owners must have
active membership in the same tenant. No actor/tenant value is accepted in a body.

Creation requires a caller-generated UUID `requestId`. A tenant/client-scoped
unique key and a hash of the normalized original payload prevent duplicate
drafts after a lost response. Same key and payload returns the stored current
record; a changed payload or deleted draft conflicts. Updates use the returned
Objective ID and version, rather than reusing creation for autosave.

Every accepted write atomically increments `version` and appends an immutable
revision containing its snapshot, actor, timestamp and operation. Content edits
return the record to Draft and clear its ready/review timestamps. Unactivated
strategies can later compare their originating objective version with current
version; this change does not claim to stale an existing unbound strategy.
Confirm ready and Request review require all four fields. Confirmation sets
Ready; review request sets In review without inventing a reviewer or notification.
An unchanged retry with the new current version returns the same state without
another revision. A stale retry conflicts and requires an authoritative reread.

Schema adds two empty tables, compound tenant/client foreign keys, bounded status
and ask values, indexes and forced tenant RLS. Soft deletion retains revisions.
The migration is prepared only and must remain LF-exact. Verification covers
four-field readiness, partial drafts, tenant/client/owner refusal, version races,
edit-to-draft behavior, DTO validation and real SQL constraints in a local
ephemeral database where available. Mocks are not live integration evidence.

Remaining separate contracts: strategy activation/Planner orchestration and
version binding (OBJ-14–16/20–21), cycle definitions (OBJ-22), relationship
recommendations (OBJ-23), decisions/dependencies (OBJ-24–25), objective file
ownership/context compilation (OBJ-27), Meri clarification (OBJ-29), successor
outcome linkage (OBJ-31), reviewer routing and closure outcome semantics.
