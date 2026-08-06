# Memory Review UX Phase 2 — Increment 1 Foundation

## Scope completed

This increment implements only the backend workflow foundation:

- durable memory-specific workflow state in the existing `review_request` table;
- body-free workflow metadata with bounded size and reason constraints;
- workflow creation in the same transaction as every shared candidate insert;
- backfill obligations for existing shared pending candidates;
- dark-rollout compatibility: trigger-created and backfilled workflows begin unassigned and unenforced;
- deterministic named-reviewer assignment using the canonical authorization policy once Phase 2 is enabled;
- tenant reviewer preference over Capiro platform administrators;
- automatic reassignment when the current reviewer loses eligibility;
- required, bounded reasons for request-changes, rejection, and manual reassignment;
- public `changes_requested` state mapped to the existing bounded DB token `changes_needed`;
- database enforcement that approval/rejection must come from the currently assigned independent reviewer after the enabled Phase 2 service has named that reviewer;
- terminal candidate decisions mirrored to workflow state in the same transaction;
- server-owned reviewer/proposer identities and assigned-reviewer-only queue filtering;
- request-changes and reviewer-assignment API routes;
- current actor authorization before administrator reassignment, including ethical-wall denial.

No notifications, email delivery, revised-candidate resubmission, full Review Inbox redesign, or browser acceptance is included yet.

## Security and correctness properties

- Candidate content remains in `memory_candidate`; `review_request.payload_jsonb` contains no memory body.
- Unauthorized callers do not load proposal bodies.
- A proposer cannot be assigned to or decide their own shared proposal.
- Once Phase 2 assigns a reviewer, a stale or changed assignment cannot win an approval race: the database checks `decided_by = assigned_to` during the terminal candidate update.
- The migration alone does not activate Phase 2 or break the existing dark path. Assignment enforcement is marked active only when the enabled application service writes a non-null reviewer assignment.
- After assignment enforcement is activated, the database guard applies to every terminal candidate update, including older compatibility routes.
- Full compatibility-route delegation and friendly error translation remain a later Phase 2 closeout item; this increment does not claim those routes are fully redesigned.
- A workflow with no currently eligible reviewer remains unassigned and therefore blocked from the Phase 2 decision surface rather than guessing authority.
- A walled administrator cannot reassign a guessed candidate id without passing the current review authorization policy.
- Audit records store reason hashes and character counts, not reviewer feedback bodies.

## Validation completed on exact implementation sources

- strict isolated production TypeScript check: PASS;
- strict isolated spec TypeScript check: PASS;
- focused runtime workflow probes: PASS, 5 scenarios;
- helper/status/reason runtime probes: PASS;
- migration structural/static probes: PASS, 9 checks;
- branch relation: 0 commits behind `main` at the time of publication;
- GitHub commit status contexts: none registered.

The runtime probes cover deterministic assignment, body-free persistence, system attribution for automatic assignment, request-changes, assigned-reviewer decision gating, rejection completion, manual reassignment, and walled-administrator reassignment denial.

## Gates intentionally not claimed

The current environment could not run or establish:

- `pnpm install --frozen-lockfile` in a full checkout;
- the complete API Jest memory suite;
- root `pnpm turbo typecheck`;
- pinned repository Prettier;
- Prisma validate/generate against the full schema;
- clean and upgrade migration replay on PostgreSQL;
- real-role RLS behavior;
- production web build, Vitest, or authenticated browser acceptance;
- GitHub Actions.

These remain required before Phase 2 completion and before merge or deployment.

## Next increment

Implement immutable revision and resubmission after `changes_requested`:

1. proposer-only revised candidate creation;
2. predecessor/successor lineage and incremented revision number;
3. atomic predecessor supersession;
4. fresh authorization and reviewer eligibility evaluation;
5. no mutation of active memory until the revised candidate is independently approved;
6. focused concurrency, lineage, wall, and compatibility-route tests.

## Safety boundary

Do not merge, deploy, apply this migration to production, or enable production flags from this increment alone. The branch and pull request remain draft until all Phase 2 increments and final acceptance gates pass.
