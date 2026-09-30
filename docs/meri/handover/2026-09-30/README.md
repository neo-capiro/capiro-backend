# Meri File01: remote coding-agent handover

Prepared 2026-09-30 for an agent with authenticated GitHub access but **no access to Neo's local files**. This is an incomplete-work handover, not a release acceptance. All links below are repository-relative or GitHub URLs. Archived machine paths identify provenance only; they are not required reading locations.

## Start here

1. Authenticate to both private repositories, `neo-capiro/capiro-agent-ops` and `neo-capiro/capirov2`.
2. Clone/fetch the operations repository, follow `BOOTSTRAP.md`, read its current `AGENTS.md` and `hermes/OPERATING.md`, and record the policy SHA. This handover used **`fe8adaa858ee2391b42697311ce91cf787e080b8`**, verified against GitHub with a clean fast-forward-only checkout. Stop policy-dependent work if current policy is unavailable. Do not use this document as standing authorization.
3. Fetch the application repository and the branch **`codex/meri-migration-closeout`**. Continue from [PR #1915](https://github.com/neo-capiro/capirov2/pull/1915), not from an old local branch or an assumed clean main. Its latest product-code commit is **`c785e566321943470978d66325952ed916951346`**; the handover commit is a descendant. Check the actual remote head before editing.
4. Read [CI diagnosis](ci/README.md), [migration handover](migration/README.md), [remaining original scope](remaining-file01.md), [preserved work](preserved-work/README.md), and [package verification](VERIFICATION.md). Keep archived proposals out of runtime source until reconciled and tested.
5. Begin with the bounded CI repairs. Do not merge, deploy, run production canaries, execute archived migration tools, or mutate the shared migration ledger as a side effect of starting the task.

Example checkout on another machine (use your own working directory):

```sh
git clone https://github.com/neo-capiro/capiro-agent-ops.git
git -C capiro-agent-ops fetch origin main
git -C capiro-agent-ops status --short
git -C capiro-agent-ops rev-parse HEAD origin/main
# Follow BOOTSTRAP.md and read the required policy files before continuing.
git clone --branch codex/meri-migration-closeout https://github.com/neo-capiro/capirov2.git
git -C capirov2 config core.autocrlf false
git -C capirov2 status --short
git -C capirov2 log -8 --oneline
```

These clone commands need existing private-repository credentials. No credentials, auth state, local database configs, customer records, or raw database snapshots are supplied here. Use the repository's pinned package manager (`pnpm@9.12.0`, Node `>=20.11.0`), frozen dependency resolution, and build `@capiro/shared` before consumers; CI details live in its workflow files. Do not substitute an arbitrary shared `DATABASE_URL` for the explicitly owned disposable test databases.

## What is in Git, and what is not complete

At the last live GitHub/local-main comparison, both mains were **`25d1339c0c0e21fe0c3c0148787fad772e5096e8`** (PR #1914). The C-drive main checkout was `C:\dev\cap-meri-outcomes-validation`, sharing `C:\dev\capirov2\.git`; both main and the active task worktree were clean. The primary `C:\dev\capirov2` worktree was occupied by other/unconfirmed work and must not be reset or cleaned.

| Commit | Status and purpose |
| --- | --- |
| `b2d99f04d8c485cb4b73a1f02aece9a60b945870` | Earlier foundation application consolidation, PR #1904, already on main. |
| PR #1910 and #1911–#1913 | Original-document fidelity and subsequent evidence/status corrections, already on main. |
| `25d1339c0c0e21fe0c3c0148787fad772e5096e8` | PR #1914 merged fail-closed entrypoint changes and a byte-exact guard for 543 existing migration SQL files. Source merge is not proof deployed images contain those changes. |
| `c5ebc226d` | PR #1915: Funding index contracts and Prisma declarations. |
| `d66c2d06c` | PR #1915: release-gate prerequisites and current configuration verification. |
| `59867b810` | PR #1915: disposable migration prerequisites and official-source discovery gates. |
| `10966694a` | PR #1915: runtime verification contracts and parity. |
| `a8baac4d7` | PR #1915: Workspace assurance fixtures and exact-owner evidence. |
| `0607ebb6857908ddca00d6763881b66d2700aebb` | PR #1915: actual verifier exit/output success and additional disposable CI prerequisites. This is the last fully observed CI head before publication of the latest fixes. |
| `c785e566321943470978d66325952ed916951346` | Latest reviewed five-file batch: asynchronous verifier backpressure, zero-based UTC month conversion, and build Meri core before Runtime Boundary checks. |

The latest batch has local targeted PASS evidence: verifier helper/gate **23 tests**, API deadline-risk **22 tests**, Intel detector/utilities **30 tests**, shared/core builds, focused YAML and isolated TypeScript checks, all exit 0. Three independent Hermes/Kimi reviews returned PASS with exit 0. The date fix changes the shared day calculation used by API and Intel (for example Sep 29 → Oct 1 is two days); it does not alter alert thresholds. CI must qualify the published exact head; old-head passes cannot be transferred.

The old `0607ebb` head had **22 successful checks and six failed checks**. Its final API matrix exited **134**, after **22 failed suite headers** and heap exhaustion; downstream Workspace/Web/evaluation steps in that matrix did not run. The five-file batch does not claim to repair all these newly diagnosed failures. Read the CI handover before choosing further code changes.

## User scope and policy boundaries

The task is the **entire original File01 Foundation and Reliability scope**, including Workstreams A–D and the applicable original acceptance requirements. It is not just migration repair. The original source documents are already versioned:

- [01-Meri-Foundation-and-Reliability.md](../../implementation/01-Meri-Foundation-and-Reliability.md)
- [01-Meri-Orchestrator-Prompt.md](../../implementation/01-Meri-Orchestrator-Prompt.md)
- [01-requirements.md](../../implementation/01-requirements.md)
- [01-memory-strategy-acceptance.md](../../implementation/01-memory-strategy-acceptance.md)
- [STATUS.md](../../implementation/STATUS.md) and the other qualification records in that directory.

The user explicitly removed **Defense chat only**. Existing Defense Budget, Program Elements, Research Portfolio discovery/source cases remain. Do not create a second chat product. File02/03 features and optional CW-09–12 expansion are not silently added.

There is one AWS environment, **capiro-dev**, in `us-east-1`; the application repository is `neo-capiro/capirov2`. UI goes only to **os.capiro.ai through web-vnext**. Existing API origins may differ; that is not permission to deploy legacy UI. Keep tenant, owner, credential, internal-review and PII boundaries intact. Meri starters fill editable intent and wait for Send.

The user previously authorized the current Meri merge/ship sequence and the exact two synthetic tenants `meri-foundation-20260928-t1` and `meri-foundation-20260928-t2`. The recorded enablement was **APPROVED_NOT_APPLIED**, not a deployment result. Task-only direct Codex repairs were authorized after repeated Hermes/Qwen tool failures, retaining independent Hermes/Kimi review. Worker model choices were Bedrock Converse `qwen.qwen3-coder-next` and `moonshotai.kimi-k2.5`, not a production routing change. These are historical task facts; the current shared policy takes precedence. This publication request authorized retaining fixes and writing the handover, not bypassing failed gates.

**Current shared policy says never mutate shared migration ledgers to recover a rollout.** Older local proposals discussing an exception are not executable authorization and are superseded where they conflict. Production canaries/authenticated production-browser tests remain user-run. A remote coding agent can implement and test offline/disposable changes; it cannot claim deployment or live acceptance without the authorized operator, credentials, required host integration and actual evidence.

## Migration and release blockers

Read the migration subdirectory for exact hashes and recorded results. Key points:

- A single integrated recovery rehearsal ran on a dedicated isolated full-copy clone, not the shared database. Its original attempt exited **1** at the postcondition validator after four normal migrations actually exited 0. The validator compared a function signature with an argument name against the dump representation without that name.
- Two complete adjusted data streams matched at **23,995,017,016 bytes**, SHA-256 **`06ce9be52e4c889c045682f6bc884059bcb2c3032ce200a6abdc4b00ed5e3571`**. That proves the documented data comparison only; it does not turn the failed run into PASS or authorize live recovery.
- A separate supplemental verifier was reviewed and had **131 offline guard tests PASS, exit 0**, but the **eight actual terminal API/Workspace operator/runtime status and no-op checks remain NOT RUN**. No supplemental clone execution was started before this handover. Do not replay the original resolutions/SQL or overwrite its receipts.
- Historical inspected Workspace, Onboard API and API Strategy images had migration wrappers that edit the shared ledger and seed. Do not invoke those wrappers. Their serve paths start Node; source guard merge alone does not establish image provenance. Pin and inspect actual immutable images before rollout.
- Main-branch workflows for API, Workspace, Strategy, Onboard, Intel and Engagement can force deployments. API/Onboard use `latest`; some other services are pinned to old digests and would simply restart those. Two scheduled jobs also reference API `latest`. Publication/deployment coordination cannot be replaced with an ECS-only hold.
- The existing Meri release executor hardcodes five services including legacy web; **do not run it unchanged**. A minimal selected-service release mechanism through approved Actions remains to be implemented/reviewed. No relevant Actions infrastructure outage was established; code-check failures do not permit CLI fallback.
- There is no established live maintenance/actor hold. No shared-ledger mutation, live release, or owner acceptance is supplied by this package.

Saved observations, not fresh health claims: the earlier partial release deployed web-vnext task 383 at digest `sha256:08332ee894c2c0f6d4d8cfecc02a4c52c0b7d00896917a220b48a4d97923f993` and Engagement task 127 at `sha256:b5ba8c108a47731104f856760dc1359c49c7fbca83cfe84f8ac2d1b97f5ccc95`. API/orchestrator foundation rollout stayed held. API task 483 had digest `sha256:640f76d01bd6d0b7658f1229aee90cd7979c75d8b0f7ab7df76a5d5b7abc3c68`, linked to an older `42942ded…` build despite a different SHA environment hint. Workspace task 43 had `sha256:16d7630ab9b7bc4919404b8481f241fb4b4e3713e8611c14fab5e3f08b3290e3`. Refresh all current service state before decisions; an env SHA is not provenance.

## Parallel work and integration ownership

[PR #1905](https://github.com/neo-capiro/capirov2/pull/1905), "Repair incident replay, memory scope, native UI, and CI contracts", was an open draft at `5f6a02d1e5202bd7aa1c2a35e9d9ae1c891e65e3` when checked for this handover. It belongs to the separate "Reconcile Capiro dev migrations" session. Do not mass-merge its much broader branch or assume its CI means a live migration completed. Compare overlapping files and coordinate ownership before integration. Its observed Outreach run was code-only, not proof of a database operation.

The required merge sequence is verified task branch → **C-drive local main** → GitHub main → approved Actions → actual commit/digest/service verification. A remote-only agent must arrange the C-drive main step with the authorized host operator; it cannot satisfy it by updating an unrelated local clone. Preserve dirty worktrees and do not force-push main. No main integration was attempted for this handover because release checks remain red.

## Recommended continuation order

1. Read fresh policy and the exact branch/diffs. Verify this package's manifest, then confirm current PR checks.
2. Repair the diagnosed CI prerequisites and stale harnesses in small owned groups. Preserve full suite coverage; the 1,762-suite discovery/shard proof is not a passing test run. Reproduce genuine source defects separately from setup failures. Obtain independent review and exact-head CI.
3. Reconcile preserved unfinished patches selectively, especially fixture ownership and memory lifecycle, with current main/current task behavior. Their presence here is archival, not approval to apply them all.
4. Implement the minimal safe release selection/immutable-image safeguards and resolve migration compatibility under current policy. A remote agent lacking authorized infrastructure access should hand the concrete operator procedure to the operator and continue independent code work; do not invent success.
5. Finish the trusted capture, artifact storage, deterministic predicates and controlled fixture ownership identified in [remaining-file01.md](remaining-file01.md). Retain all fail-closed guards until the contracts actually exist.
6. After authorized compatible deployment, run the permitted synthetic acceptance through the operator/user as required by current policy. Start with original `01,12,14,17,20,46,51,72,74,CD-02,CD-05`; then complete the full original scope and actual output grading.
7. Reconcile final requirements, acquisitions, release/rollback and acceptance evidence. Update the canonical [01 handover](../../implementation/01-handover.md). Do not claim `01_READY_FOR_02` until its remaining gates are actually satisfied.

## What is deliberately not in this package

No raw database contents/catalog/ledger snapshots, full logs, credentials, auth cookies, `.env`, secret configs, customer documents, or machine session state. The migration archive includes selected source and sanitized aggregate facts, not the private evidence needed to rerun its pinned checks. Hashes identify retained host evidence but do not make missing evidence available. A remote agent must regenerate appropriate disposable evidence or request the authorized operator's sanitized result; it must not fabricate it.

Unrelated/unknown-owner changes in the primary checkout are preserved on the host and were not appropriated. Historical unsafe seeds and raw semantic-gateway SSE proposals were not activated. This package is sufficient to resume code diagnosis, scope reconciliation and safe planning; it does not make every infrastructure operation portable or complete.
