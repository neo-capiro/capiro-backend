# Outreach V3 Revised Phase 5 — Final Implementation Handoff

## Repository state

Repository: `neo-capiro/capirov2`

Branch:

```text
agent/outreach-v3-p5-context-strategy
```

Base Phase 4 implementation head:

```text
208dae611d9f5636f3b7507f8782ff7cc864c4ed
```

Phase 5 implementation was complete through the pre-handoff commit:

```text
41b254606e333e16a1262605101271cf8a892010
```

The branch head after this handoff commit is the authoritative Phase 5 implementation head and must be resolved directly before later work/verification.

## Status

**Phase 5 implementation: COMPLETE**

**Phase 5 executable verification: DEFERRED**

The product owner explicitly chose to defer Phase 4 and Phase 5 verification and validate Phases 4-6 together after the Phase 6 UI implementation.

Do not interpret this handoff as `OUTREACH_V3_PHASE5_APPROVED`.

## Delivered

### Governed context contract

Implemented exact context classes:

```text
required_policy
writing_guidance
campaign_fact
target_specific
group_safe
```

Implemented exact scopes:

```text
campaign
target
group
```

Accepted context is stored as resolved immutable Campaign Spec snapshots with content-addressed context keys, source snapshots and deterministic snapshot hashes.

### Context sources

Implemented:

```text
memory_item
capiro_record
document
government_record
target_profile_fact
manual
```

### Shared Capiro capabilities

Promoted to implemented and registered for shared Meri/Outreach use:

```text
search_memory
research_government
get_document
recommend_outreach_strategy
```

### Campaign commands

Implemented:

```text
ACCEPT_CONTEXT_REFS
EXCLUDE_CONTEXT_REFS
```

The command engine resolves/reauthorizes accepted references server-side before the pure reducer may persist them.

Historical state restore reauthorizes both selected targets and accepted context.

### Sponsor/client isolation

Client-specific accepted context requires exactly one explicit sponsor client and must belong to that same client.

Direct context discovery APIs enforce the same sole-sponsor rule.

A null client locator/scope is tenant-neutral only, not a wildcard.

Multi-client/coalition/firm/internal/no-sponsor campaigns cannot silently mix client-confidential context in Phase 5.

### Privacy hardening

- owner-private memory visibility preserved;
- memory lifecycle/expiration preserved;
- ethical walls preserved;
- private meeting attachment visibility rechecked;
- raw document bytes/S3 credentials excluded;
- private note/email/transcript bodies excluded;
- wrong-client/wrong-sponsor discovery degrades through nonleaking not-found behavior.

### Strategy

Added deterministic `recommend_outreach_strategy` capability using only canonical campaign/target/context counts/state.

It recommends:

```text
delivery pattern
personalization level
tone
length
unresolved decisions
safety notes
```

It never mutates campaign state.

### Reasoning integration

Reasoning can use:

```text
search_memory
research_government
get_document
recommend_outreach_strategy
```

Context acceptance proposals must be grounded in exact referenced tool-result selections.

Exclusion proposals must reference current Campaign Spec context or exact referenced tool evidence.

Reasoning still creates pending proposals only and has no command-engine Apply authority.

### Dark context API

Mounted only in the existing `engagement-api` runtime.

Feature flags:

```text
OUTREACH_V3_STATE_ENABLED
OUTREACH_V3_CONTEXT_ENABLED
```

Exact routes are frozen in:

```text
apps/api/src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json
```

### Readiness

Phase 5 enables deterministic context readiness and adds:

```text
CONTEXT_HAS_UNVERIFIED_EVIDENCE
```

Generation, drafts and preflight remain unavailable.

## Implementation-review repairs closed during finalization

- corrected government-research tenant capability envelope;
- inherited sole-client scope in memory search;
- made null memory scope tenant-neutral only;
- made context locator client IDs exact rather than wildcard;
- inherited client scope in document inspection;
- preserved private meeting visibility for meeting-linked documents;
- added direct context API sole-sponsor enforcement;
- updated command-engine tests for the new context resolver dependency;
- added context acceptance/authorization/sponsor-isolation regression cases.

See:

```text
docs/plans/outreach-v3/revised-phase-5-findings.md
```

## Verification scaffolding delivered

```bash
pnpm verify:outreach-v3-phase-5
pnpm verify:outreach-v3-phase-5:local -- --sha "$(git rev-parse HEAD)"
```

Permanent Phase 5 tests/contracts include:

```text
context canonicalization/scope contract
sponsor isolation
command-engine context authorization
context feature guard
exact context route manifest
Phase 5 architecture boundary
existing reasoning regression suites
```

These commands have **not** been declared green in this handoff because validation is intentionally deferred.

## Explicit nonchanges

```text
No final Outreach V3 UI
No Outreach v2 replacement
No draft generation
No draft approval
No preflight
No email send
No provider-send authority
No LangGraph/LangSmith
No Prisma migration
No new Fargate service
No AWS deployment
No canonical Engagement cutover
No worker/callback/Recall ownership transfer
```

## GitHub/AWS publication state

Phase 5 implementation commits are on the GitHub feature branch.

No Phase 5 pull request was opened by this handoff because PR creation is a separate GitHub publication action.

No AWS action was performed.

## Phase 6 gate

Phase 6 is the final Outreach UI implementation phase in the revised roadmap.

The product owner’s new final mockups are required before final UI implementation starts. The previous prototype is not the final visual contract.

Read:

```text
docs/plans/outreach-v3/revised-phase-6-readiness.md
```

After Phase 6 implementation, perform the owner-directed combined Phase 4-6 verification and repair all resulting P0/P1/blocking-P2 findings before declaring the stack accepted.
