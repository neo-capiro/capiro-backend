# MeriV2 Memory, Context, and Assurance Rollout

## Scope

This runbook begins **after** the exact merge SHA has passed the local release preflight, additive migrations have succeeded, the five services have been deployed with all controls dark, and the two additive operations stacks exist with both EventBridge schedules disabled.

The end-to-end merge, image-build, migration, and dark AWS deployment procedure is:

```text
docs/runbooks/meriv2-merge-and-aws-ship.md
```

> The AWS environment named `dev` serves production traffic. Treat `dev` as production.

GitHub Actions is not an acceptance dependency. The authoritative release command is:

```bash
pnpm verify:meriv2-release -- \
  --ops-context .artifacts/meriv2-aws-context-dev.json \
  --profile capiro-dev
```

## Required operators

| Role                | Responsibility                                               |
| ------------------- | ------------------------------------------------------------ |
| Release operator    | Executes commands, captures evidence, and controls expansion |
| Database reviewer   | Accepts migration and each exact backfill job                |
| Security reviewer   | Accepts tenant, owner, wall, grant, and audit behavior       |
| Product/UX reviewer | Accepts browser, accessibility, held, and degraded states    |
| Incident commander  | Can stop rollout and authorize rollback                      |

No implementer may be the sole production approver.

---

# 1. Preconditions

Record in the change ticket:

1. exact 40-character merge SHA;
2. `MERIV2_LOCAL_RELEASE_PREFLIGHT_OK` evidence for that SHA;
3. successful clean and upgrade database rehearsal;
4. successful authenticated browser/accessibility acceptance;
5. production migration task ARN and exit code `0`;
6. stable API, orchestrator, Workspace, Strategy, and web services on immutable image digests;
7. prior task-definition ARNs and database snapshot identifier;
8. dark operations-stack deployment with both rules `DISABLED`;
9. internal canary tenant UUID;
10. named reviewers and incident commander.

Stop if any core service is degraded, migration status is unclear, or an unexplained alarm is active.

---

# 2. Initial dark values

The deployed API task definition must contain:

```text
MEMORY_GOVERNANCE_TENANTS=
MEMORY_GOVERNANCE_LIFECYCLE=off
MEMORY_GOVERNANCE_ENFORCE=off
MEMORY_CLIENT_REVIEW=off
MEMORY_GOVERNANCE_CENTER=off
MEMORY_AUTOLEARN_GOVERNED=false
MERIV2_CONTEXT_PACKET_V2=off
CONTEXT_PACKET_V2=
MERI_POLICY_PACK_SOURCE=off
MERI_POLICY_PACK_TENANTS=
MERI_RELEASE_GATE=off
MERI_RELEASE_GATE_TENANTS=
MERI_RELEASE_GATE_SURFACES=
MERIV2_CONTROL_METRICS=on
```

Orchestrator, Workspace, and Strategy task definitions must also have Context and assurance modes off and no stale tenant/surface selections.

A global `enforce` value is not sufficient to activate governed memory, persisted policy, or assurance. Each system requires an exact server-owned tenant selection. A deploy with only one switch set remains dark.

Never begin a production canary with `all` tenants or `all` surfaces.

---

# 3. Read-only dark smoke

Before enabling a schedule or feature:

- verify every service health endpoint;
- exercise legacy chat, MeriV2 chat, In-editor, Workspace, Strategy, and Steward;
- verify private memory remains owner-only;
- verify shared memory still behaves as before while governance is dark;
- inspect logs for migration errors and confidential content;
- run the read-only control snapshot and governance diagnostic.

```bash
pnpm --filter @capiro/api exec tsx scripts/emit-meriv2-control-metrics.ts
pnpm --filter @capiro/api exec tsx scripts/diag-memory-governance-v2.ts \
  --tenant-id <internal-tenant-uuid>
```

Do not backfill during the initial smoke.

---

# 4. Enable the projection worker

The stack is:

```text
Capiro-dev-MemoryProjectionWorker
```

Its EventBridge rule is:

```text
capiro-dev-memory-projection-worker
```

Run the task manually against no work or a controlled synthetic obligation. Verify:

- exact source version/content-hash binding;
- lease ownership;
- successful Titan embedding;
- no memory body in logs;
- retry and stale-lease behavior;
- no dead letter.

Then deploy only the independent operations app with:

The dark baseline established by the release deployment is:

```text
enableMemoryProjectionWorker=false
enableMeriV2ControlMonitor=false
```

Arm only the worker by re-deploying that app with:

```text
enableMemoryProjectionWorker=true
enableMeriV2ControlMonitor=false
meriv2ApiImageDigest=<immutable sha256:... digest of that SHA-tagged image>
releaseSha=<exact release SHA>
```

The CDK app refuses to arm a scheduled task without an immutable `sha256:` digest;
the release SHA is carried separately as audit evidence.

Observe at least two schedule intervals before continuing.

---

# 5. Enable the control monitor

The stack is:

```text
Capiro-dev-MeriV2Control
```

Its EventBridge rule is:

```text
capiro-dev-meriv2-control-monitor
```

Run the task manually once against the migrated schema. Then deploy only the independent operations app with:

```text
enableMemoryProjectionWorker=true
enableMeriV2ControlMonitor=true
meriv2ApiImageDigest=<immutable sha256:... digest of that SHA-tagged image>
releaseSha=<exact release SHA>
```

Verify two consecutive successful snapshots and the following bounded namespace:

```text
Capiro/MeriV2Control
```

The only dimension may be `Environment`. No tenant, user, client, memory, policy, prompt, model, source, or content identifier may appear as a dimension.

Do not run the deliberate alarm-breach demonstration in `dev`; `dev` is production.

---

# 6. Enable governed memory for one internal tenant

Update the API task definition with the exact canary UUID:

```text
MEMORY_GOVERNANCE_TENANTS=<internal-tenant-uuid>
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

Keep review and Governance Center off initially.

Validate:

- personal explicit memory activates atomically;
- shared proposals remain pending;
- proposer cannot self-approve;
- pending/rejected/revoked/superseded/expired memory is withheld;
- stale and controlling-conflict policy is truthful;
- terminal states suppress recall synchronously;
- exact projection obligation is created in the same transaction;
- wall and private-owner denials are server-derived;
- no other tenant changes behavior.

Stop on any recall regression, cross-client disclosure, or outbox backlog.

---

# 7. Enable client review and Governance Center

After the core lifecycle is accepted:

```text
MEMORY_CLIENT_REVIEW=enforce
MEMORY_GOVERNANCE_CENTER=enforce
```

Validate with distinct users:

- first-time shared Settings file creates a standard review proposal;
- edit to an existing shared Settings file creates an immutable correction proposal;
- active shared content remains unchanged while review is pending;
- independent approval creates a new controlling version;
- the original Settings type/slug resolves the current descendant after reload;
- prior version remains in history;
- proposer withdrawal and reviewer rejection are distinct;
- standard user with an active client approval grant succeeds;
- missing, expired, revoked, wrong-client, or wall-blocked grants fail closed;
- legal hold blocks destructive operations;
- correction, contradiction, conflict resolution, revoke, restore, and projection retry work through the product UI.

Do not use direct SQL to repair a product-flow failure.

---

# 8. Context Packet v2 shadow

Set the global ceiling:

```text
MERIV2_CONTEXT_PACKET_V2=shadow
```

Then set, in the internal tenant’s server-owned `clioFeatureFlags`:

```text
meriv2.contextPacketV2=true
meriv2.contextPacketV2.chat=true
```

Start with one exact surface. Shadow must:

- compile and persist v1 and v2 evidence;
- continue feeding v1 to the model;
- record bounded inclusion, exclusion, ordering, health, token, conflict, confidentiality, and relevance differences;
- expose no confidential bodies in comparison evidence.

Accept only after wall exclusions, required/optional layers, packet persistence, latency, and output parity are reviewed.

Expand Context surfaces one at a time. Do not enable Context and assurance enforcement in the same change.

---

# 9. Persisted policy shadow

Create, review, second-approve where required, simulate, and publish the internal tenant’s policy pack through the product lifecycle. Do not seed policy rows with SQL.

Then set:

```text
MERI_POLICY_PACK_SOURCE=shadow
MERI_POLICY_PACK_TENANTS=<internal-tenant-uuid>
```

In shadow:

- the reviewed static product baseline remains authoritative;
- persisted selection and outcome are recorded for comparison;
- missing, invalid, tampered, or unpublished packs never authorize an action;
- simulation remains nonbinding.

Review exact pack key, version, rule, decision hash, context hash, actor, effective user, jurisdiction, channel, recipient type, tool, and effective time.

---

# 10. Assurance shadow

Set all three controls:

```text
MERI_RELEASE_GATE=shadow
MERI_RELEASE_GATE_TENANTS=<internal-tenant-uuid>
MERI_RELEASE_GATE_SURFACES=chat
```

Shadow computes the operating frame, evidence plan, claim ledger, deterministic findings, release decision, and envelope without changing output.

Review:

- unsupported high-risk claim rate;
- false positives and false negatives;
- verification availability;
- latency and cost;
- low-risk streaming parity;
- browser-forged envelope rejection;
- Context Packet and policy drift rejection at destination boundaries.

The standalone Workspace `generate-section` endpoint must be included when Workspace is canaried; it has its own pre-response release boundary and must not be treated as covered solely by generate-all.

---

# 11. Enforce in bounded order

After each shadow surface is accepted, change only that surface to enforcement:

```text
MERIV2_CONTEXT_PACKET_V2=enforce
MERI_POLICY_PACK_SOURCE=enforce
MERI_RELEASE_GATE=enforce
```

Keep exact tenant and surface lists.

Recommended order:

1. internal Chat;
2. internal In-editor;
3. Workspace standalone section;
4. Workspace generate-all/retry/apply;
5. Strategy;
6. Steward;
7. memo;
8. district brief;
9. Outreach last;
10. one design-partner tenant;
11. small cohort;
12. general availability.

For each expansion record task definition, tenant/surface selection, start time, dashboard evidence, held/degraded counts, user-impact review, and go/no-go decision.

Never expand tenant scope and surface scope simultaneously.

---

# 12. Backfill after stable code canary

A code deployment does not execute governance classification.

For each tenant:

1. prepare/dry-run;
2. review job ID, plan hash, counts, and quarantine;
3. obtain database and tenant/security approval;
4. execute with exact tenant and job confirmations;
5. verify convergence;
6. observe;
7. retain the job for drift-safe rollback.

Use:

```text
docs/runbooks/meriv2-memory-backfill.md
```

Do not proceed to another tenant while drift or quarantine is unexplained.

---

# 13. Stop conditions

Stop expansion and follow the rollback runbook for:

- tenant, owner, client, or ethical-wall disclosure;
- successful shared self-review;
- successful policy four-eyes bypass;
- required Context Packet persistence failure;
- unsupported high-risk content released or persisted;
- stale Context or policy binding accepted;
- existing shared Settings truth replaced in place;
- stable Settings identity returning a superseded version;
- outbox age over 15 minutes, repeated worker crash, or dead letter;
- legal-held data mutated destructively;
- unexplained backfill drift/quarantine;
- content, source excerpts, session tokens, or secrets in logs or metrics;
- service instability;
- unexplained control alarm.

---

# 14. Rollback

Use:

```text
docs/runbooks/meriv2-memory-context-assurance-rollback.md
```

The order is:

1. freeze expansion;
2. remove the smallest tenant/surface canary;
3. move the affected subsystem to shadow/off;
4. disable the affected schedule;
5. restore previous service task definitions;
6. roll back only the exact drift-safe backfill job;
7. roll policy back through independently reviewed publication;
8. use a separate forward-repair change for migration problems.

Do not drop additive schema during an ordinary incident and do not delete governance evidence.

---

# 15. Completion evidence

Attach:

- exact merge SHA and image digests;
- local release preflight summary;
- migration task and status;
- service task-definition ARNs before and after;
- operations-stack outputs and schedule states;
- every tenant/surface feature value;
- browser/accessibility acceptance;
- Context, policy, and assurance summaries containing no content;
- dashboard/alarm exports;
- each backfill job/plan hash and approval;
- final rollback-readiness confirmation.

A rollout is not complete while any required item is described as unexecuted, pending, blocked, or to be verified.
