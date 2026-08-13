# Engagement Program — Source Plan Provenance Registry

**Purpose:** make every historical Engagement/Outreach plan name discoverable from the repository and map it to current implementation truth.
**Current authority for remaining work:** `docs/plans/engagement-program/canonical-remaining-work-plan.md`
**Current session handoff:** `docs/plans/engagement-program/2026-08-10-session-handoff.md`

## How to use this registry

Historical plans remain valuable for requirements, threat models, edge cases, test matrices, and rollout sequencing. Their exact file paths, line numbers, SHAs, branch names, and implementation assumptions may be stale.

For a fresh session:

1. find the old filename below;
2. read its filename-preserving redirect under `docs/plans/engagement-program/source/`;
3. read the listed current repo handoff/PR docs;
4. inspect current code before editing;
5. use `canonical-remaining-work-plan.md` for unresolved work.

A redirect file does **not** assert that every historical line remains executable. It preserves plan provenance and prevents a future agent from silently losing a requirement family.

---

## Family A — Engagement API extraction / Fargate program

| Historical source filename | Original purpose | Current repo authority / state |
|---|---|---|
| `phase-0-engagement-api-baseline-executable-plan.md` | Freeze current Engagement routes, dependencies, writes, security, and baseline before extraction | Merged extraction history + `docs/plans/engagement-api/`; current remaining cutover in `canonical-remaining-work-plan.md` |
| `phase-1-engagement-api-local-runtime-executable-plan.md` | Create second local `engagement-api` runtime while current web remains main-only | Merged PR #755; `docs/plans/engagement-api/phase-1-handoff.md` |
| `phase-2-engagement-api-dark-fargate-executable-plan.md` | Provision/deploy dark dedicated Fargate request-serving path with external actions disabled | Accepted work is in ancestry of merged Phase 3 stack; verify current infra before any new deploy |
| `phase-2-engagement-api-dark-fargate-ui-aware-micro-sessions.md` | UI-aware dark-service implementation/validation decomposition | Historical execution guide; current route/runtime evidence under `docs/plans/engagement-api/` |
| `phase-3-engagement-api-full-existing-ui-parity-micro-sessions.md` | Prove current Engagement SPA against preview `engagement-api` | Merged PR #781; `docs/plans/engagement-api/phase-3-handoff.md` |
| `phase-3-engagement-api-full-ui-parity-gpt-5.6-pro-single-run.md` | Single-run executor version of Phase 3 parity plan | Historical executor wrapper; merged PR #781 is current implementation truth |
| `phase-4-engagement-api-decouple-ownership-executable-plan-gpt-5.6.md` | Break reverse dependencies and assign future service ownership without premature production cutover | Partially represented by shared foundations/ownership work; remaining ownership transfer is Workstream H |
| `HANDOVER-phase5-closed-phase6-inflight.md` | Historical extraction handoff into remaining Phase 6 work | Superseded for current state by `2026-08-10-session-handoff.md` |
| `phase-6-remaining-work-plan.md` | Historical remaining extraction workstreams | Superseded for current unresolved work by `canonical-remaining-work-plan.md` |
| `PHASE-6-WS-A-D-HANDOFF.md` | Historical handoff after Phase 6 workstreams A–D | Reference only; current status must be audited against main/current service |
| `engagement-api-outreach-v3-master-context.md` | Master context tying service extraction and Outreach V3 together | Current program index + Outreach revised phase docs + current code |

### Extraction program current facts

- PR #755 is merged and established the second request-serving runtime using the shared Engagement source/database.
- PR #781 is merged and established full current-UI parity/preview infrastructure; accepted Phase 2 dark-runtime work is in its ancestry.
- Those merges did **not** by themselves complete customer canonical cutover or transfer workers/callbacks/Recall/external actions.
- The dedicated service is intended for the whole Engagement Manager request-serving plane, not Outreach alone.

---

## Family B — Engagement trust boundary / generation / UX / SOC 2

Historical aggregate source package: `capiro-engagement-all-phases-implementation-plan.md`.

The aggregate contained these individual plan filenames:

| Historical source filename | Original purpose | Current use |
|---|---|---|
| `00-engagement-implementation-roadmap-index.md` | Four-phase execution roadmap and shared invariants | Safety/sequence reference; current unresolved work consolidated here |
| `phase-0-engagement-trust-boundary-plan.md` | Immutable versions, audit/approval/send-intent/provider trust boundary | Foundations implemented across historical Engagement PRs; still authoritative invariants for V3 draft/send work |
| `phase-1-engagement-generation-context-plan.md` | Evidence Packet, generation gateway, prompt/context governance | Must be reconciled with current generation gateway and context-correctness plan before V3 generation |
| `phase-2-engagement-ux-completion-plan.md` | User-facing draft/exception/preflight/resume/accessibility completion | Standalone V3 visual contract supersedes layout, but lifecycle/exception requirements remain relevant |
| `phase-3-engagement-quality-soc2-validation-plan.md` | Eval matrix, CI/release gates, SOC 2 operating evidence | Current Workstream G + final release acceptance |
| `capiro-engagement-deep-audit.md` | Deep baseline audit that produced the phased roadmap | Historical evidence/source analysis; re-audit current code before relying on issue presence |

### Invariants retained from this family

- no raw caller bypasses immutable version/audit before real send;
- approval references exact version;
- durable send intent exists before provider call;
- unknown provider result is not automatically retried;
- enforce mode fails closed;
- no cross-tenant or implicit cross-user access;
- untrusted factual evidence cannot act as hidden instructions;
- regeneration does not overwrite user edits;
- attachment omission/failure is explicit;
- no autonomous external send;
- OAuth/token/notetaker boundaries remain change-controlled.

---

## Family C — Engagement context correctness / async generation

Historical aggregate source package: `engagement-context-correctness-all-phases.md`.

It contained these individual plans:

| Historical source filename | Goal | Current use |
|---|---|---|
| `phase-0-engagement-containment-client-boundaries.md` | Owner/client boundary containment | Audit current main before assuming incomplete; invariant remains active |
| `phase-1-recipient-evidence-packet-isolation.md` | One recipient-correct packet per draft | Mandatory architecture for V3 governed generation |
| `phase-2-async-versioned-generation-parity.md` | Async generation must match versioned synchronous semantics | Mandatory before broad/large async V3 generation |
| `phase-3-async-intel-authorized-snapshots.md` | Durable async Intel evidence without bearer-token persistence | Mandatory for async Intel/LegiWatch/government evidence |
| `phase-4-large-batch-context-scaling.md` | Bound large-batch context work and remove scope explosion | Mandatory before 40-recipient canary |
| `phase-5-group-audience-correctness.md` | Server-authoritative group policy/common facts | Mandatory for shared-thread/group messages |
| `phase-6-context-trust-and-provenance-ux.md` | Truthful trust/provenance UI | Mandatory for Context Used / evidence receipts |
| `phase-7-evaluation-and-ci-release-gates.md` | Permanent cross-feature matrix | Consolidated in Workstream G |
| `phase-8-production-canary-and-closeout.md` | Controlled canary and program closeout | Consolidated in Workstream I |
| `99-independent-review-prompt.md` | Fresh independent reviewer instructions | Use after implementation, never replace executable evidence |

### Invariants retained from this family

- recipient-specific context never influences another recipient's plan/verifier/draft;
- client-specific content never crosses clients;
- no-client campaigns do not inherit client-private material;
- browser submits IDs/user text, never authoritative protected source bodies;
- async jobs do not persist bearer tokens;
- large campaigns run off the request path with durable slot identity;
- group messages use only compatible/common authorized facts;
- “available to model” is distinct from “used in final draft”;
- every real send references an immutable audited version through a durable send intent.

---

## Family D — Outreach V3 conversational rebuild

| Source/current plan | Current repo state |
|---|---|
| `agentic-conversational-outreach-rebuild-plan.md` | Historical master design/architecture input; revised phases and current remaining plan supersede stale anchors |
| `Outreach V3 (standalone)(2).html` | **Current visual/interaction authority where it differs from earlier Figma**; artifact hash frozen in `revised-phase-6-standalone-layout-supersession.md` |
| `revised-phase-1-shared-foundations.md` and Phase 1 handoffs | PR #822 |
| `revised-phase-2-campaign-state.md` and validation/readiness docs | PR #862 |
| `revised-phase-3-reasoning.md` and validation/readiness docs | PR #881 |
| `revised-phase-4-target-intelligence.md` and final handoff | PR #883 |
| `revised-phase-5-context-strategy.md` and final handoff | PR #890 |
| Phase 6 design/state/findings/handoff/supersession docs | PR #891 |

## Outreach revised PR chain

```text
#822 Phase 1 shared foundations
  ↓
#862 Phase 2 Campaign Spec / command engine
  ↓
#881 Phase 3 thin reasoning gateway
  ↓
#883 Phase 4 target intelligence
  ↓
#890 Phase 5 governed context / strategy
  ↓
#891 Phase 6 conversational planning UI
```

Do not infer generation/send completion from this chain. Phase 6 deliberately stops before those authorities.

---

## Filename-preserving redirects

Redirect files under `docs/plans/engagement-program/source/` intentionally retain the historical filenames above. They exist so repository search finds the original names and points the reader to current authority.

The redirects are preferable to silently copying stale line-number anchors as if they were current execution truth.

## Current unresolved authority

For implementation after Phase 6, use:

```text
docs/plans/engagement-program/canonical-remaining-work-plan.md
```

It reconciles the still-valid requirements from all four plan families into the current sequence:

```text
exact-head Phase 4–6 closeout
→ Capiro internal whole-Engagement HTTP canary
→ V3 tenant gate
→ representative samples / recipient-isolated generation
→ immutable drafts / exact-version approval
→ preflight / durable send intent
→ provider outcomes / unknown no-auto-retry
→ context/group/scale matrix
→ permanent eval/release gates
→ one-by-one background ownership transfer
→ customer cutover
→ legacy retirement
```
