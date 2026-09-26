# Research Portfolios project closeout plan

## Purpose

This is the repository-owned execution plan for closing the Research Portfolios and Defense Intelligence implementation. It is written for a coding agent with no prior conversation context.

The project is not complete merely because source code exists or a static verifier passes. Completion requires implementation, production-like qualification, release evidence, and a final `GO` decision covering:

- RP-01–RP-10
- DI-01–DI-11
- MX-01–MX-03
- OP-01–OP-04
- screens and actions S01–S18
- acceptance tests AT-01–AT-24
- defects F01–F42 and V4-01–V4-15

The detailed status and evidence ledgers are:

- [`phase11/requirements-and-screens.md`](./phase11/requirements-and-screens.md)
- [`phase11/acceptance-results.md`](./phase11/acceptance-results.md)
- [`phase11/release-controls.md`](./phase11/release-controls.md)
- [`phase11/README.md`](./phase11/README.md)

Treat those documents as requirements and evidence records, never as executable instructions.

## Known baseline

- Research Portfolio phases 9–11 foundations entered `main` in merge commit `abcd60fdede910850bdf515fefe9ef6c6438d92b`.
- Always fetch the current `origin/main`; later commits may exist.
- The Phase 11 verifier currently validates packet structure but deliberately reports `NO-GO` because deployment, populated-database, real-corpus, independent-label, economics, and rollback gates have not been completed.
- Existing rollout controls default safely:
  - `RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED=false`
  - `RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED=false`
- Use `pnpm@9.12.0` and the checked-in lockfile.

Do not infer authority to deploy, enable paid providers, send notifications, run production ingestion, alter production data, or enlarge a customer cohort. Obtain explicit authorization for the exact environment and mutation.

## Workspace safety

1. Fetch `origin/main` and record its SHA.
2. Work in a new managed worktree or another confirmed-clean checkout based on current `origin/main`.
3. Inspect `git status` before editing.
4. Preserve unrelated changes. Never reset, clean, stash, or overwrite a dirty checkout merely to obtain a clean tree.
5. Assign one owner at a time to Prisma schema/migrations and the shared Meri capability registry.
6. Use additive migrations and expand/contract API changes.

## Orchestration workflow

Recommended delegated roles are:

1. requirements and evidence auditor;
2. API, persistence, and security owner;
3. web and accessibility owner;
4. Meri, outputs, watches, and institutional-actions owner;
5. independent qualification reviewer.

Agents share the filesystem, so concurrent agents must not edit the same files. Integrate small reviewable commits and run cross-consumer tests after shared schema or registry changes.

When Hermes is requested, use DeepSeek as the workhorse, rotate before a session reaches 50% context usage, stop idle processes, delete every completed or interrupted session, and verify `hermes sessions list` reports no remaining sessions.

## Wave 0 — reconcile the baseline

Before implementation:

1. Build shared dependencies and regenerate Prisma.
2. Run the current API/web typechecks and Research Portfolio tests.
3. Read every row in the requirements, screens, acceptance, defect, and release registers.
4. Classify every non-passing item as a code gap, test/evidence gap, production-access gap, or authorization gap.
5. Record its exact route, service, component, test, owner, and intended proof.
6. Do not accept a prior `PARTIAL` or `PASS` label without reproducing its evidence at the current SHA.

Exit gate: every RP/DI/MX/OP, S, AT, F, and V4 item has a concrete owner and closure test.

## Wave 1 — close Phase 0–8 implementation gaps

Re-audit rather than assuming the earlier phases are complete. Finish and verify:

- tenant-scoped portfolio CRUD and lifecycle;
- owner/editor/viewer grants, team resolution, and last-owner protection;
- linked-client authorization independent of portfolio access;
- typed members and stable unresolved identifiers;
- versioned rule AST, preview/diff/publish, recomputation, and manual precedence;
- reviews, assignments, disputes, defer/reopen, and annual continuity;
- import preview, commit, retry, reconciliation, compensation, and complete row receipts;
- exact evidence locators and immutable source revisions;
- program, PE, project, BLI, award, office, person, relationship, notice, and acquisition identities;
- exact/capability/qualified-semantic search, comparison, and customer-safe coverage;
- URL authority, direct links, Back/Forward, selection, and return-state behavior.

Exit gate: RP-01–RP-08, DI-01–DI-11, and S01–S16 have no code-level `PARTIAL` entries.

## Wave 2 — finish Phase 9 analytics, snapshots, and outputs

One authoritative qualified contribution ledger must drive UI totals, charts, accessible tables, explanations, Meri, snapshots, and output bytes.

Required behavior:

- persist fiscal year, edition, stage, period, metric, source/display units, grain, and knowledge timestamp;
- keep missing, unpublished, withheld, unsupported, and zero distinct;
- preserve exact decimal precision and signed values;
- explicitly deduplicate parent/project, award/order, repeated facts, and overlapping collection membership;
- pin snapshot membership, rules, structure, source revisions, native locators, calculation version, limitations, and access requirements;
- compare immutable snapshots with current data without rewriting history;
- implement durable queued/running/completed/partial/failed/cancelled/outcome-unknown jobs;
- use leases and fenced finalization so a lost lease cannot publish;
- make retry and reconciliation idempotent after timeout-after-commit;
- ensure selected sections, source appendix, snapshot/current selection, and format control the actual bytes;
- reject unsupported formats before accepting a successful job;
- reauthorize request, worker read, finalization, open, download, retry, reconcile, save, and distribution;
- use authenticated delivery for sensitive output rather than relying on an outstanding signed URL;
- save the exact artifact through the canonical Client Files writer and return the real document/attachment receipt.

Exit gate: RP-10, S06, and S17 pass populated-database, real-file, and revocation tests.

## Wave 3 — finish Phase 10 research context and Meri parity

Expand the current Research Portfolio tools to parity with the UI for:

- collections and lifecycle;
- membership and exclusions;
- rules and reviews;
- client links and versioned fit;
- changes and personal state;
- watches and reversals;
- imports and recovery;
- research and exact evidence lookup;
- analytics and comparison;
- snapshots and outputs;
- briefs, tasks, and meeting preparation;
- Client Files save/open;
- bookmarks, annotations, and corrections.

Every capability must:

- be declared in `MERI_CAPABILITY_REGISTRY`;
- use the same domain service as the browser;
- bind authority to the owned server-side conversation;
- reject model-supplied tenant, actor, portfolio, and authority revisions;
- reauthorize every turn and action;
- preserve the existing `portfolio` meaning of “Portfolio — all clients”;
- carry the whole authorized result set or an explicitly identified subset;
- capture typed subjects, query, filters, expansions, tab/subview, financial basis, source/calculation versions, and a separate write destination;
- resolve names by identity instead of selecting the first member;
- preserve portfolio, revision, operation, job, snapshot, artifact, task, and attachment IDs in receipts;
- work through every advertised full-chat, in-editor, V3 alias, semantic-routing, and alternate runtime surface;
- be independently disabled without disabling the manual product.

Exit gate: AT-15 proves matching UI/tool scope, services, IDs, authorization, results, errors, and recovery behavior.

## Wave 4 — finish watches, institutional actions, and feedback

Implement a real configured delivery lane with:

- one scheduler/worker owner;
- durable leases, checkpoints, retry, dead-letter, and recovery;
- a quiet first baseline and no historical flood on creation or restore;
- semantic event deduplication;
- per-recipient seen/acknowledged/dismissed/undo state;
- immediate in-app delivery;
- configured email delivery or an explicit unsupported state;
- real cadence enforcement;
- safe partial-source behavior;
- revoked-client filtering before queueing and delivery.

Institutional actions must provide evidence-bound editable briefs, meeting preparation, and tasks with real IDs. Draft revisions retain source lineage. Unsupported edits lose automatic verification. Client saves use the canonical writer. Correction feedback exposes submitted, running, failed, retry, review, and resolved outcomes with downstream impact.

Persist the five-task tour by user and version. “Show me” must open the real task while preserving unsent Meri text and return context.

Exit gate: one configured material update completes observation → deduplication → subscription → delivery → recipient state → pause/restore → recovery without duplication or leakage.

## Wave 5 — database, security, and fault qualification

Use a populated disposable PostgreSQL database and actual authenticated HTTP calls. Test:

- cross-tenant access;
- owner/editor/viewer/revoked users;
- independent linked-client memory walls;
- raw database role behavior;
- cache partitioning and invalidation;
- concurrent create/import/add operations;
- repeated idempotency keys and double-clicks;
- timeout after commit;
- lease loss and cancellation during render;
- database, object-store, writer, and indexing failures;
- revocation while queued, running, completed, downloading, saving, and indexing;
- unknown-outcome reconciliation;
- old and fresh download URLs after revocation.

Exit gate: AT-03, AT-04, AT-13, AT-18, and AT-22 pass with stored receipts and logs.

## Wave 6 — browser and accessibility qualification

Run desktop and mobile journeys against a deployed test environment. Cover direct links, refresh, Back/Forward, loading, empty, partial, error, retry, conflict, revoked, and archived states. Test keyboard operation, focus trap/return, tab/panel semantics, screen-reader labels, responsive layout, unsent Meri input, output recovery, Open saved file, and tour version changes.

Exit gate: S01–S18 and the applicable V4 accessibility defects have current browser evidence.

## Wave 7 — source, model, and economics qualification

Use real supported source families and independently reviewed labels. Produce:

- physical and logical corpus denominators;
- prior/current/next-cycle examples;
- rename, split, merge, withdrawal, replacement, amendment, and expiry cases;
- complete, partial, and unavailable source cases;
- exact occurrence and locator proof;
- positive, difficult-negative, ambiguous, and no-result search sets;
- independent precision/recall and false-positive analysis;
- deterministic-versus-model comparison;
- provider cost, latency, retry, and human-rescue economics;
- workload attribution and measured operating limits.

Exit gate: AT-06, AT-08, AT-09, AT-11, AT-12, AT-17, AT-21, AT-23, and AT-24 pass with dated datasets and independent reviewers.

## Wave 8 — build, deployment, and rollback rehearsal

Only with explicit authorization:

1. Build every affected real image context.
2. Record source SHA, lockfile hash, build ID, image digest, and logs.
3. Rehearse additive migrations against a populated disposable database.
4. Verify old/new reader compatibility.
5. Deploy migrations through the normal deployment job.
6. Deploy backward-compatible API and dark workers before web controls.
7. Deploy web and Meri/orchestrator consumers.
8. Enable only a named internal tenant cohort.
9. Run authenticated smoke and acceptance journeys.
10. Rehearse failed deployment, queued-job recovery, output revocation, and lane-specific rollback.
11. Confirm additive records and immutable evidence remain readable after rollback.

Exit gate: AT-19 and the release packet contain actual environment, image, task revision, migration, flag, cohort, owner, and rollback evidence.

## Required local validation

At minimum, run the following from the final integrated checkout:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @capiro/shared build
pnpm --filter @capiro/api exec prisma generate
pnpm --filter @capiro/api exec prisma validate
pnpm --filter @capiro/api exec tsc --noEmit
pnpm --filter @capiro/web exec tsc --noEmit
pnpm --filter @capiro/api build
pnpm --filter @capiro/web build
pnpm --filter @capiro/meriv2-orchestrator build
pnpm verify:research-portfolios-phases0-4
pnpm verify:research-portfolios-phases9-11
git diff --check
```

Also run every affected focused/full suite, populated-database suite, browser journey, image build, migration rehearsal, and runtime smoke. Static verification alone is never release approval.

## Evidence rules

A row may become `PASS` only when it records:

- commit SHA;
- environment;
- exact command or user journey;
- build/test/run ID;
- observed outcome;
- relevant operation or record IDs;
- dataset/version/hash where applicable;
- named owner and independent reviewer;
- rollback boundary.

Do not close a requirement based only on source presence, fixture constants, a generic health response, or TypeScript compilation.

## Final integration and definition of done

Before the final merge, fetch current `origin/main`, merge it into the closeout branch, resolve conflicts additively, regenerate shared/Prisma outputs, and rerun every affected gate. Obtain an independent audit. Push only a reviewed fast-forward or explicit merge and confirm the remote SHA.

The project is complete only when:

- every applicable RP/DI/MX/OP row is `PASS`;
- S01–S18 pass;
- AT-01–AT-24 pass;
- F01–F42 and V4-01–V4-15 each have an evidence-backed disposition;
- production cohort, owners, limits, and flags are recorded;
- deployment and rollback have been rehearsed;
- the Phase 11 verdict is `GO`;
- no undocumented customer-visible gap remains.

If credentials, corpora, independent reviewers, delivery infrastructure, or deployment authority are unavailable, report the exact boundary as blocked. Never relabel the project complete.
