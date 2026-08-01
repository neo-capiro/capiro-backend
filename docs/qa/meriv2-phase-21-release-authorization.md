# MeriV2 Phase 21 — Release Authorization and Trusted Merge Vehicle

## Status

**DEVELOPMENT COMPLETE — PR #679 may be marked ready for independent review.**

**Merge authorization remains conditional** on the exact final head passing the repository-owned local release preflight and receiving all required independent approvals. GitHub Actions is not an acceptance dependency.

No merge to `main`, AWS deployment, shared/production migration, tenant backfill, policy publication, feature activation, customer-data mutation, external send, or production rollout was performed while preparing this record.

## Trusted merge vehicle

- Repository: `neo-capiro/capirov2`
- Pull request: `#679`
- Base: `main`
- Head: `agent/meriv2-world-class-closeout`
- Merge method: normal merge commit; no force-push or public-history rewrite
- Production environment warning: AWS environment `dev` serves production traffic

The exact final base/head SHAs belong in the PR description and release evidence because this file cannot contain the SHA of the commit that creates itself.

## Phase disposition

| Phase range | Development disposition               | Required final evidence                                                             |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| 0–4         | Complete                              | API/web tests, immutable Settings lifecycle, Phase 18/19                            |
| 5–6         | Complete                              | worker/outbox tests, operations synth/diff, Phase 18                                |
| 7–9         | Complete                              | Context persistence/rollout and governed recall tests                               |
| 10–13       | Complete                              | policy, backfill, grant, withdrawal/rejection tests and rehearsals                  |
| 14–16       | Complete                              | accessibility and cross-surface assurance tests/browser scenarios                   |
| 17          | Local matrix complete as code         | exact final SHA must pass `pnpm verify:meriv2-development`                          |
| 18          | Database rehearsal complete as code   | clean and upgrade replay must pass locally                                          |
| 19          | Browser rehearsal complete as code    | authenticated Clerk/Chrome matrix must pass locally                                 |
| 20          | Control system complete as code       | independent operations synth/diff and operator review                               |
| 21          | Trusted PR package complete           | four independent approvals and exact-head evidence                                  |
| 22          | Production operators/runbook complete | explicitly authorized migration, dark deploy, smoke, canary, and rollback readiness |

The full phase-by-phase development review is:

```text
docs/qa/meriv2-development-completeness-review.md
```

## Final gaps closed before authorization for review

The final audit closed development issues that were not merely test or operations gaps:

1. existing shared Settings edits now route through immutable reviewed versions;
2. stable Settings type/slug resolves the active immutable descendant;
3. racing first-time Settings approvals cannot replace active truth;
4. Settings source vocabulary uses `approved_document_edit`;
5. standalone Workspace `generate-section` applies the Phase 16 claim gate before response;
6. Phase 18 and Phase 19 disposable runners explicitly select their test tenants;
7. dark task preparation clears every current and legacy tenant/surface selector;
8. exact-SHA/digest migration and dark ECS deployment has a guarded executable with automatic service rollback;
9. the independent operations stacks have a guarded dark deployer;
10. every release `.mjs` operator is syntax- and safety-checked before preflight.

No known development omission remains after those corrections.

---

# Local acceptance gate

## Development matrix

From a clean checkout of the final PR head:

```bash
pnpm verify:meriv2-development
```

This runs:

- release-automation syntax/safety checks;
- locked dependency install;
- five Prisma client generations;
- required package builds;
- formatting and whitespace validation;
- Phase 0–22 static completeness;
- Phase 20 control contract;
- package and full-repository typechecks;
- API, orchestrator, Strategy, Workspace, web, and core tests;
- MeriV2 evaluations;
- clean and current-main-equivalent PostgreSQL 16 + pgvector replay;
- schema drift, forced RLS, application-role, lifecycle, outbox, backfill, policy, and Context rehearsal.

Required markers include:

```text
MERIV2_RELEASE_SCRIPTS_OK
MERIV2_DEVELOPMENT_COMPLETENESS_OK
```

## Authenticated release matrix

Collect read-only AWS identifiers:

```bash
pnpm collect:meriv2-aws-context -- \
  --env dev \
  --profile capiro-dev \
  --region us-east-1 \
  --output .artifacts/meriv2-aws-context-dev.json
```

Then run:

```bash
pnpm verify:meriv2-release -- \
  --ops-context .artifacts/meriv2-aws-context-dev.json \
  --profile capiro-dev
```

Release mode adds:

- four real Clerk test actors;
- real API and web processes;
- Chrome browser and accessibility acceptance;
- denied-response confidentiality scanning;
- independent operations-stack synthesis;
- read-only AWS CDK diff.

The merge gate requires:

```text
MERIV2_LOCAL_RELEASE_PREFLIGHT_OK
```

No `--skip-database`, `--skip-browser`, or unreviewed `--skip-aws-diff` waiver is permitted for merge authorization.

---

# Required independent review

PR #679 requires approval from four distinct responsibilities:

1. **Code owner / security reviewer**
   - tenant/private/client/ethical-wall isolation;
   - independent review and four-eyes policy;
   - legal hold and audit confidentiality;
   - assurance and action-policy boundaries.

2. **Database / migration reviewer**
   - 14 additive migrations;
   - clean and upgrade replay;
   - Prisma diff;
   - forced RLS and application-role grants;
   - outbox/backfill rollback safety.

3. **Product / UX reviewer**
   - Settings immutable review behavior;
   - proposer/reviewer distinction;
   - Governance Center;
   - Context Inspector;
   - held/degraded Chat, In-editor, Workspace, Strategy, Steward, and proposal-card states;
   - desktop, tablet, mobile, keyboard, and screen-reader behavior.

4. **Release operator**
   - exact SHA and image identity;
   - production baseline/rollback points;
   - migration and dark deployment procedure;
   - operations-stack isolation;
   - smoke/canary/stop sequence.

The implementer cannot substitute for those approvals.

---

# Merge authorization criteria

PR #679 may be merged only when all are true:

- final head is current with `main` and mergeable;
- working tree is clean;
- local development and release preflights pass on that exact head;
- database and browser evidence artifacts identify that head;
- independent operations synth/diff is reviewed;
- all four review responsibilities approve;
- no unresolved review thread or known development blocker remains;
- release operator records prior task definitions, database snapshot, exact merge/build plan, and incident commander.

When those criteria are met, Phase 21 authorizes a normal merge commit. It does not authorize immediate feature enforcement or backfill.

---

# Post-merge production boundary

Run the local release preflight again on the exact merge SHA. Then follow:

```text
docs/runbooks/meriv2-merge-and-aws-ship.md
```

The guarded production commands are:

```bash
pnpm prepare:meriv2-ecs-release -- --sha <merge-sha> ...
pnpm ship:meriv2-ecs-release -- --sha <merge-sha> ...
pnpm deploy:meriv2-operations-dark -- --sha <merge-sha> ...
```

The initial AWS release:

- applies additive migrations;
- deploys API, MeriV2 orchestrator, Workspace, Strategy, and web from immutable digests;
- deploys the projection-worker and control stacks with both schedules disabled;
- keeps governed-memory tenants, Context Packet v2, policy packs, assurance, auto-learning, and external sends dark;
- performs no backfill.

Feature and schedule activation requires the separate Phase 22 smoke/canary sequence.

---

## Final Phase 21 decision

The branch is no longer development-blocked. It is appropriate to mark PR #679 **ready for review**. Merge remains conditioned on local exact-head evidence and independent approval. No production action is authorized merely by changing the PR from draft to ready.
