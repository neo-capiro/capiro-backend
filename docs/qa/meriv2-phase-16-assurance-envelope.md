# MeriV2 Phase 16 — Cross-Surface Assurance Envelope

## Status

**Implementation present; exact-head focused/cumulative validation and internal canary acceptance pending.**

PR #679 remains draft and unmerged. Phase 16 performed no production deployment, shared migration, production flag change, customer-data mutation, secret retrieval, external send, or AWS environment operation.

## Objective

Use one server-owned, integrity-bound assurance envelope before persistence or release on high-risk generation surfaces, while keeping low-risk conversation normal and preventing one section's finding from holding unrelated content.

## Canonical contract

The envelope contains:

```ts
{
  operatingFrame,
  evidencePlan,
  claimLedger,
  findings,
  releaseDecision,
  blockers,
  warnings,
  verifierVersion,
  contextPacketId,
  policyBinding,
  generatedAt,
  hash
}
```

Findings carry one explicit attribution:

```text
run
section:<section identity>
claim:<claim identity>
```

A finding is `run` only when the verifier cannot truthfully narrow it or when the condition affects the complete generation.

## Rollout contract

All three values must be explicit:

```text
MERI_RELEASE_GATE=shadow|enforce
MERI_RELEASE_GATE_TENANTS=<tenant IDs>|all
MERI_RELEASE_GATE_SURFACES=<surface names>|all
```

Unset/invalid values are `off`. Truthy aliases are not accepted.

Exact surfaces:

```text
chat
in-editor
workspace-gen
strategy
research
outreach
memo
district-brief
steward
```

### Off

- changes no release, persistence, streaming, or application behavior;
- may retain inherited non-Phase-16 diagnostics only.

### Shadow

- computes the same operating frame, evidence plan, claim ledger, deterministic findings, release decision, and envelope used by enforce;
- does not replace, suppress, repair, reorder, or hold user-visible output;
- does not block an edit or artifact;
- records bounded evidence only.

### Enforce

- high-risk content is evaluated before irreversible streaming, apply, save, or external release;
- `deliver` releases;
- `deliver_with_flags` follows the surface's reviewed human-approval policy;
- `repair` or `hold` cannot become persisted/released content;
- a verification failure at the destination fails closed for the governed write.

## Confidentiality contract

Operational logs and metrics may include:

- surface;
- rollout mode;
- release decision;
- verifier version;
- Context Packet ID;
- policy-pack ID/version;
- counts;
- bounded reason codes; and
- envelope hash.

They must not include:

- claim text;
- finding span;
- memory bodies;
- generated sections;
- prompts;
- email bodies;
- provider payloads; or
- secrets.

## Server trust boundary

The destination must never trust browser-supplied:

- tenant or role;
- rollout mode/surface;
- ethical-wall decision;
- context health;
- `verified` flag;
- release decision;
- Context Packet ID;
- policy-pack identity/version; or
- envelope hash.

The server resolves the actor/tenant and recomputes or verifies the envelope before the governed operation.

## Focused automated matrix

Run on one exact head:

```bash
pnpm --filter @capiro/meriv2-core exec jest --ci --runInBand \
  src/assurance/assurance.spec.ts \
  src/assurance/release-switch.spec.ts \
  src/assurance/rollout.spec.ts \
  src/assurance/envelope.spec.ts

pnpm --filter @capiro/meriv2-orchestrator exec jest --ci --runInBand \
  src/meri/chat/chat-assistant.service.spec.ts \
  src/meri/in-editor/in-editor-assistant.service.spec.ts \
  src/meri/strategy/strategy-assurance.spec.ts \
  src/meri/steward/steward-assurance.spec.ts

pnpm --filter @capiro/api-strategy exec jest --ci --runInBand \
  src/agents/execution-assurance.spec.ts \
  src/agents/execution-assurance.switch.spec.ts

pnpm --filter @capiro/workspace exec jest --ci --runInBand \
  src/generation/generation-assurance.spec.ts
```

Also require:

```bash
pnpm --filter @capiro/meriv2-core typecheck
pnpm --filter @capiro/meriv2-orchestrator typecheck
pnpm --filter @capiro/api-strategy typecheck
pnpm --filter @capiro/workspace typecheck
pnpm turbo run typecheck
```

## Required assertions

### Shared envelope

- identical input produces a stable claim-ledger hash;
- envelope hash validates;
- modified decision or content produces hash mismatch;
- wrong surface is refused;
- Context Packet drift is detected;
- policy-pack version/binding drift is detected;
- verifier-version drift is detected;
- operational summary contains no claim text.

### Low-risk chat

- low-risk conversation streams normally in off, shadow, and enforce;
- low-risk help is never broadly refused merely because the gate is enabled.

### High-risk chat and persisted chat tools

- unsupported high-risk prose is held before release in enforce;
- shadow changes no response body;
- a model-authored persisted memo/note body is refused before the tool writes;
- server-rendered tools without model-authored prose remain available;
- missing verification fails closed only in enforce.

### In-editor

- off returns original edits;
- shadow runs assurance and returns byte-equivalent edits;
- enforce withholds unsupported high-risk edits before apply;
- advice-only turns remain available;
- a non-canaried tenant remains unaffected;
- a browser cannot forge verified state.

### Workspace

- unsupported high-risk section is held;
- unrelated section remains releaseable;
- finding span is attributed to the originating section;
- genuinely run-wide failure affects every applicable section;
- a structural warning is attached only to matching PE/claim sections;
- persisted Context Packet and policy binding can be carried in the envelope.

### Strategy/Outreach

- shadow reports blockers without holding;
- enforce holds unresolved provenance/degraded context;
- policy and Context Packet drift invalidate a stale envelope;
- destination verifies envelope hash and recomputes structural checks;
- missing or forged envelope cannot authorize artifact staging.

### Steward

- shadow preserves every extracted fact;
- enforce removes only unsupported high-risk facts;
- low-risk fact remains available even with an unresolved anchor;
- surviving conflict indices are correctly remapped;
- policy drift is detectable;
- finding attribution identifies the extracted claim.

## Internal canary procedure

Use an internal tenant only. Do not use customer data.

### 1. Off baseline

Record 30–50 representative requests across:

- low-risk conversational help;
- bill/status questions;
- budget figures and deltas;
- in-editor factual edits;
- Workspace multi-section generation;
- Strategy and Steward outputs;
- memo/outreach artifacts.

Capture bounded request IDs, surfaces, output hashes, latency, decisions, and reviewer outcomes. Do not retain raw confidential content in the Phase 16 evidence document.

### 2. Shadow

Set global shadow and select only the internal tenant plus one surface at a time.

For each request verify:

- output hash equals the off-baseline output hash where inputs/model fixture are deterministic;
- no edit/artifact is withheld;
- envelope exists and verifies;
- findings are attributed correctly;
- no denied tenant/client identity appears;
- metrics contain bounded metadata only.

### 3. Reviewer sample

Review every shadow `repair`/`hold` and a random sample of `deliver` decisions.

Classify:

```text
true positive
false positive
true negative
false negative
```

Proposed Phase 16 acceptance thresholds:

- zero known critical false negatives in the pinned regression set;
- false-positive rate no greater than 5% for sampled high-risk decisions;
- zero low-risk broad-refusal cases;
- zero cross-tenant/client disclosure;
- zero browser-forged authority acceptance;
- zero un-attributed section findings when an originating span exists.

Any higher false-positive rate requires repairing the classifier/evidence mapping and repeating shadow.

### 4. Enforce canary

Enforce one internal surface at a time:

1. in-editor;
2. Workspace;
3. Strategy/Steward;
4. chat;
5. memo/outreach and other external deliverables.

Verify supported output releases and unsupported output is held before persistence/release. Verify low-risk conversation remains normal.

### 5. Rollback

Set the selected surface to shadow, then off. Confirm behavior returns to baseline without deleting envelopes, findings, or audit evidence.

## Acceptance record template

```text
Exact head:
Exact main/base:
Date:
Operator:
Internal tenant:
Surfaces canaried:
Focused tests:
Cumulative tests:
Typechecks/builds:
Shadow request count:
Shadow output-change count:
Reviewed hold/repair count:
True positives:
False positives:
False-positive rate:
Known critical false negatives:
Low-risk broad refusals:
Cross-tenant/client disclosures:
Browser-forged authority accepted:
Rollback result:
Overall: PASS/FAIL
```

## Acceptance gate

Phase 16 is accepted only when:

- the focused and inherited cumulative gates pass on one exact synchronized head;
- internal shadow changes no output;
- the reviewed false-positive rate satisfies the threshold;
- there is no broad low-risk refusal regression;
- unsupported high-risk content is held before persistence/release in enforce;
- one section's finding does not hold unrelated sections;
- stale Context Packet or policy binding is refused;
- browser-forged verification is ignored; and
- rollback to shadow/off succeeds.

## Rollback

Set the global mode to `off`, clear tenant/surface selectors, and preserve all stored evidence. Do not delete findings, rewrite envelope decisions, or remove audit records as rollback.
