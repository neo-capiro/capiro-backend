# MeriV2 Phase 21 — Release Authorization and Trusted Merge Vehicle

## Status

**BLOCKED — PR prepared, but release is not authorized.**

Phase 21 requires PR #679 to be current, mergeable, fully green, accurately documented, independently reviewed, and free of unresolved blockers after Phases 0–20 pass. The PR and release ledger have been updated as a trusted draft merge vehicle, but Phases 17–20 have not passed their operating acceptance gates. The pull request must remain draft and unmerged.

No merge, deployment, AWS change, shared or production migration, tenant backfill, policy publication, feature activation, customer-data mutation, external send, secret retrieval, or production rollout was performed.

## Release identity used to prepare this record

- Repository: `neo-capiro/capirov2`
- Pull request: `#679`
- Base branch: `main`
- Base SHA: `b792f2d24920d56d7addcda88a602c6282563f47`
- Release branch: `agent/meriv2-world-class-closeout`
- Parent head used to prepare this record: `907f4acf89f2cb3d0a83f53d2c1418f1766ac703`
- Branch relation before this record: 0 commits behind `main`, mergeable, open, draft, and unmerged

The exact final head that contains this record is maintained in the PR description because a file cannot contain the SHA of the commit that creates itself.

## Phase disposition

| Phase range | Disposition | Release consequence |
|---|---|---|
| 0–9 | Earlier hosted acceptance records exist | accepted baseline only; must still survive final exact-head matrix |
| 10 | Implemented; hosted acceptance blocked by GitHub Actions | unresolved blocker |
| 11 | Local/disposable PostgreSQL acceptance recorded | must be repeated by final exact-head database gate |
| 12–13 | Focused exact-head local acceptance recorded | must survive final matrix |
| 14 | Local accessibility acceptance recorded | authenticated final browser gate still required |
| 15 | Administrator UI implemented; operating acceptance pending | unresolved blocker |
| 16 | Cross-surface assurance implemented; internal shadow/enforce canary pending | unresolved blocker |
| 17 | Final CI and synchronization matrix committed; zero legitimate hosted jobs | blocked |
| 18 | Clean/upgrade database rehearsal committed; zero legitimate database jobs | blocked |
| 19 | Authenticated browser/accessibility harness committed; zero legitimate browser jobs | blocked |
| 20 | Control mapping, metrics, alarms, and runbooks committed; no independent walkthrough or AWS alarm demonstration | blocked |
| 21 | Trusted draft PR package prepared | not authorized to mark ready or merge |

## Major findings closed in code

The branch contains the implemented resolutions for the closeout findings, including:

- atomic candidate creation/activation, canonical mutation, transition evidence, and projection obligation;
- independent review for shared firm/client memory;
- immutable corrections, contradictions, conflict resolution, revocation, and restoration;
- canonical governed classification and source/approval metadata;
- exact projection completion with source version, content hash, idempotency key, leases, retries, supersession, and dead letter;
- truthful Context Packet persistence and tenant/surface rollout controls;
- wall-aware least-privilege grants, private ownership, archived-client denial, legal holds, and impersonation-aware authority;
- proposer withdrawal distinguished from reviewer rejection;
- accessible Context Inspector, Governance Center, and reviewer/proposer surfaces;
- persisted policy-pack lifecycle, four-eyes review, selected-version decisions, integrity hashes, simulation, publication, retirement, and rollback;
- government-affairs evidence planning, claim ledger, deterministic checks, release hold/repair, and cross-surface assurance envelope;
- reversible, tenant-scoped, hash-bound governance backfill;
- bounded Phase 20 control metrics, read-only monitoring, alarms, dashboard, and executable runbooks.

These are implementation statements, not a substitute for the missing final operating evidence.

## Database migrations included

The release contains these 14 additive MeriV2 migrations:

1. `20260729010000_memory_governance_context_v2`
2. `20260729011000_memory_governance_lineage`
3. `20260811010000_assurance_policy_packs`
4. `20260811020000_assurance_eval_runs`
5. `20260811030000_assurance_feedback_fixtures`
6. `20260811040000_memory_index_outbox_subject`
7. `20260812010000_memory_immutable_versions`
8. `20260812020000_memory_cleanup_worker_leases`
9. `20260812030000_memory_projection_exact_completion`
10. `20260813010000_policy_pack_action_authority`
11. `20260813020000_policy_pack_lifecycle_concurrency`
12. `20260814010000_memory_governance_backfill_jobs`
13. `20260814011000_memory_governance_backfill_delete_guards`
14. `20260815010000_memory_candidate_withdrawal`

The migrations are designed as additive, forward-only controls. They are not authorized for production until Phase 18 proves clean replay, current-main-equivalent upgrade replay, Prisma status, schema parity, RLS, application-role behavior, lifecycle scenarios, and no manual SQL repair on one exact accepted SHA.

## Feature flags and defaults

A code deployment alone must not activate the release.

| Control | Accepted values | Default / dark behavior | Activation dependency |
|---|---|---|---|
| `MEMORY_GOVERNANCE_LIFECYCLE` | exact `enforce` or off | off/unset | migrations, backfill readiness, lifecycle tests |
| `MEMORY_GOVERNANCE_ENFORCE` | exact `enforce` or off | off/unset | lifecycle armed; authority/wall/grant acceptance |
| `MEMORY_CLIENT_REVIEW` | exact `enforce` or off | off/unset | lifecycle and authorization both armed |
| `MEMORY_GOVERNANCE_CENTER` | exact `enforce` or off | off/unset | lifecycle and authorization both armed |
| `MERIV2_CONTEXT_PACKET_V2` | `off`, `shadow`, `enforce` | off | global ceiling plus server-owned tenant and exact-surface canary |
| tenant context flags | master and exact surface booleans | absent/false | only after global ceiling is shadow/enforce |
| `MERI_POLICY_PACK_SOURCE` | `off`, `shadow`, `enforce` | off | published verified pack and policy lifecycle acceptance |
| `MERI_RELEASE_GATE` | `off`, `shadow`, `enforce` | off | explicit tenant list and surface list are also required |
| `MERI_RELEASE_GATE_TENANTS` | explicit UUIDs or `all` | absent | never begin a canary with `all` |
| `MERI_RELEASE_GATE_SURFACES` | explicit surface names or `all` | absent | expand one accepted surface at a time |
| `MEMORY_AUTOLEARN_GOVERNED` | strict true allowlist | false | not part of initial production activation |
| `MERIV2_CONTROL_METRICS` | `on` or `off` | on outside test; test off unless forced | observability only; `off` is a kill switch |
| CDK `enableMeriV2ControlMonitor` | `true` or other | false | separate control stack, migrated schema, read-only monitor success |

## CI and test evidence

### Earlier accepted evidence

Earlier phase records identify successful targeted and hosted runs for accepted phases. Those runs demonstrate the implementation’s incremental development but are not the final release gate for the current head.

### Final exact-head evidence

The required current-head evidence is absent:

- Phase 17 final CI: not executed;
- Phase 18 clean/upgrade database rehearsal: not executed;
- Phase 19 authenticated browser/accessibility acceptance: not executed;
- Phase 20 disposable control workflow: not executed;
- Phase 20 AWS alarm transition and notification: not executed;
- non-implementer runbook walkthrough: not executed.

GitHub continues to register only orphan workflow identity `324351375` (`BuildFailed`) with `startup_failure` and zero jobs. These runs are blockers, not test evidence.

## Schema parity and database rehearsal

Schema parity is **not established** for the final branch head. The committed Phase 18 harness is designed to verify:

- migration zero-to-tip replay;
- current-main-equivalent upgrade replay;
- identical final migration-name sets;
- `prisma validate` and `migrate status`;
- `prisma migrate diff --exit-code`;
- required tables, columns, indexes, checks, triggers, and forced RLS;
- real `capiro_app` application-role isolation;
- candidate, memory-version, conflict, legal-hold, outbox, backfill, policy-pack, and Context Packet behavior.

The harness has not run, so the PR must not claim database readiness.

## Browser and accessibility acceptance

The committed Phase 19 harness requires real Clerk sessions for proposer, independent reviewer, client-granted reviewer, and ethical-wall-denied user. It covers the required memory lifecycle, confidentiality, viewport, keyboard, focus, live-region, reduced-motion, Context Inspector, chat/editor, Workspace, Strategy/Steward, export, and policy-version prepared states.

It has not run. Supplemental deterministic fixtures do not satisfy the authenticated acceptance gate.

## SOC 2 and operational controls

Phase 20 provides:

- complete control mapping;
- 15 bounded `Capiro/MeriV2Control` metrics with only the `Environment` dimension;
- runtime emitters on canonical authorization, persistence, assurance, and policy-drift boundaries;
- read-only aggregate database monitor with a success/failure heartbeat;
- separate disabled-by-default CDK control stack;
- encrypted SNS alarms and dashboard;
- guarded staging/test-only alarm payload;
- rollout, rollback, backfill, and policy-pack runbooks.

Operating evidence remains absent. No alarm has been demonstrated in AWS, no notification delivery has been verified, no non-implementer has completed the runbooks, and Phase 18 rollback procedures have not been executed on the final SHA.

## Required deployment order after authorization

The authoritative rollout runbook is:

```text
docs/runbooks/meriv2-memory-context-assurance-rollout.md
```

High-level order:

1. reconfirm one accepted release SHA and capture live baseline;
2. deploy code with all new controls dark;
3. apply additive migrations through the dedicated migrate task;
4. run read-only diagnostics;
5. prepare, review, execute, and verify tenant backfills one tenant at a time;
6. deploy the separate control stack with schedule disabled, then explicitly enable after successful manual monitor runs;
7. arm governed lifecycle;
8. arm governed authorization;
9. arm review and Governance Center surfaces;
10. run Context Packet v2 shadow tenant/surface canaries;
11. run persisted policy-pack shadow;
12. run assurance shadow;
13. enforce one internal tenant/surface at a time;
14. expand Workspace, Strategy/Steward, memo/district brief, and external-action surfaces only after preceding evidence is accepted.

## Required rollback order

The authoritative rollback runbook is:

```text
docs/runbooks/meriv2-memory-context-assurance-rollback.md
```

High-level order:

1. freeze expansion and preserve evidence;
2. remove the smallest tenant/surface canary;
3. move the affected subsystem from enforce to shadow/off;
4. disable only the affected scheduled rule when needed;
5. restore previous coordinated service task definitions;
6. roll back the exact drift-safe backfill job when required;
7. roll back policy by publishing a prior independently reviewed version;
8. handle failed migration through a separate forward-repair change;
9. do not drop additive schema during an incident except under extraordinary destructive-change authorization.

## Required final reviews

The plan requires independent review from:

1. code owner / security reviewer;
2. database / migration reviewer;
3. product / UX reviewer;
4. release operator.

Those final review requests are deliberately **not issued yet** because the prerequisite acceptance evidence is missing. Requesting them now would imply release readiness that does not exist. The implementer cannot substitute for any of these reviewers.

## Phase 21 acceptance checklist

| Gate | Current result |
|---|---|
| PR current with `main` | yes at preparation time — 0 commits behind |
| PR mergeable | yes at preparation time |
| PR draft/unmerged | yes |
| Exact base/head documented | final head to be placed in PR description |
| Major findings documented | yes |
| Migration list documented | yes |
| Flags/defaults documented | yes |
| Schema parity established | **no** |
| Final CI green | **no** |
| Database rehearsal green | **no** |
| Browser/accessibility acceptance green | **no** |
| SOC 2 controls operating evidence complete | **no** |
| Deployment and rollback order documented | yes |
| Required independent reviews approved | **no** |
| No unresolved blockers | **no** |
| No-production-action statement accurate | yes |

## Authorization decision

**NO-GO.**

Keep PR #679 draft, open, mergeable if possible, and unmerged. Do not deploy or apply migrations from this branch. Restore legitimate CI or run the committed exact matrices from an authenticated clean checkout, complete Phases 17–20 on one synchronized SHA, obtain all required reviews, then update this record and the PR description before marking ready.
