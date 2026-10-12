# Wording-only handoff result

Source `539f62e7f2a3f87d9f56f1281e6fff717aed0958` changes the exact two supplied
shared-memory reasons and the scope-specific pending message, plus contradictory
comments. Complete coordinator-supplied wording is retained in the evidence.

The public response remains `{ saved: false, scope, candidateId, message }`.
Both shared rules remain WARN. Every new shared proposal, including an
administrator's, starts pending. An authorized `user_admin` or `capiro_admin`
may subsequently approve their own proposal under existing authorization.
Ordinary firm grants do not confer approval. Ordinary client reviewers still need
current grants, assignment and a different proposer. Tenant/client/wall checks,
self-rejection versus withdrawal, private ownership and automated review remain
the canonical policy's responsibility. The personal-memory alternative remains
an offer requiring another user request.

Only human-readable reason/message semantics change. No new fields, endpoint,
status, role, permission, evaluator, JSON shape, Meri public contract version or
automatic save was added. Full-file AST comparison, after removing comments and
substituting only the two reason values and pending message value, matches main.
Exact-string runtime assertions are separate from that scope check.

The existing source and tests still distinguish creation from review. An older
test named "MemoryCandidateService.approve — independent reviewer" calls the
legacy path without an actor context; it is not evidence that an administrator
with current governed authority is forbidden to approve their own proposal.
Current administrator exception controls also run in the authorization and review
workflow suites. No canonical authorization code was changed to satisfy wording.

No migration, database write, provider message, model workload, deployment or
permission change was performed. Main and all preserved candidates remain
unchanged. Changed-path intersections with the listed preserved candidates are
empty; see `path-intersections.json`.
