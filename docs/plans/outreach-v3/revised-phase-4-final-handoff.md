# Outreach V3 Revised Phase 4 — Final Implementation Handoff

## Status

```text
BRANCH: agent/outreach-v3-p4-target-intelligence
BASE: b043a995928314f7085b7f9df94bdba02cee9640
DRAFT PR: #883
IMPLEMENTATION: COMPLETE
SOURCE-REVIEW KNOWN OPEN P0: 0
SOURCE-REVIEW KNOWN OPEN P1: 0
SOURCE-REVIEW KNOWN BLOCKING P2: 0
EXECUTABLE VERIFICATION: DEFERRED BY OWNER
INDEPENDENT VALIDATION: DEFERRED BY OWNER
MERGE/DEPLOY/FLAG ENABLEMENT: NOT AUTHORIZED
```

Phase 4 is ready to serve as the stacked implementation base for Phase 5. It is not independently accepted or production-ready until the combined Phase 4–6 validation pass is run.

## Implemented

### Canonical target state

- strict source-owned target locators;
- canonical target keys independent of email;
- normalized source-aware target snapshots;
- content hashes and source versions;
- manual targets remain campaign-local;
- campaign-local recommendation rejections;
- server resolution inside the command transaction;
- restore-time target reauthorization;
- deterministic add/remove/reject commands.

### Shared target capabilities

- `search_targets`
- `get_target_profile`
- `analyze_relationships`
- `analyze_target_coverage`
- `find_similar_targets`

All are registered for both Meri and Outreach through the shared capability registry.

### Target search

Current sources:

- federal Directory members;
- federal Directory staff;
- active state legislators;
- authorized client people;
- authorized Engagement contacts;
- client-specific target recommendation cache.

Recommendations include deterministic references, role/contact health, jurisdiction, explainable signals, source scope, and unsupported-criteria notices. Recommendations never auto-apply.

### Profiles

Profiles include:

- identity, current/historical role and office;
- contact status;
- committee, chamber, state and district;
- relationship owner/last-contact metadata;
- open-ask and commitment availability;
- known interests, objections, preferred approach and public-position availability;
- district/state nexus;
- relevant bill, Program Element and funding-interest availability;
- approved and prohibited personalization categories;
- stale/disputed/conflicting-field status;
- explicit restricted categories and provenance.

Unavailable sections are represented honestly rather than inferred.

### Coverage and similarity

- deterministic target health;
- contactability and duplicate-address collision detection;
- staff/principal/chamber/committee/state coverage;
- relationship-proof gap;
- shared capability and session coverage endpoint;
- explainable similar-target ranking.

### Reasoning boundary

- target tools are read-only;
- model proposals remain pending;
- exact target locators must be grounded in Capiro tool results;
- coverage gaps remain advisory;
- reasoning has no direct command-engine, generation, approval or send authority.

### Dark APIs

Mounted only in the existing `engagement-api` runtime behind:

```text
OUTREACH_V3_STATE_ENABLED=true
OUTREACH_V3_TARGETS_ENABLED=true
```

Disabled behavior is 404.

## Validation intentionally deferred

The owner directed Phases 4, 5 and 6 to be implemented first and validated together. Therefore this handoff does not claim:

- passing TypeScript/build/tests;
- passing database or authoritative local acceptance;
- passing independent review;
- production readiness.

The GitHub Actions run associated with the first Phase 4 PR head ended in `startup_failure` before jobs were created. That is retained as an environment result, not a pass.

## Combined validation commands retained for later

```bash
pnpm verify:outreach-v3-phase-4
pnpm verify:outreach-v3-phase-4:local -- --sha "$(git rev-parse HEAD)"
```

## Phase 5 stacking rule

Phase 5 must branch from the exact final Phase 4 head. It may activate context references and strategy capabilities, but it must not copy target implementations, add generation/send authority, or treat profile facts as automatically approved context.
