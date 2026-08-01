# MeriV2 World-Class Closeout — Phase 16 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Phase 16:** Implemented; exact-head validation and internal canary acceptance pending

This ledger continues the prior closeout work logs. It does not authorize merge, migration, deployment, feature activation, customer-data mutation, external send, or production rollout.

---

## Phase 16 — cross-surface assurance envelope

### Canonical envelope

`@capiro/meriv2-core` now owns one integrity-bound assurance envelope containing:

- government-affairs operating frame;
- evidence plan;
- claim ledger;
- deterministic findings with `run`, `section`, or `claim` attribution;
- release decision, blockers, and warnings;
- verifier version;
- durable Context Packet ID when supplied by a server boundary;
- exact policy-pack identity/version/rule and decision/context hashes when supplied;
- server timestamp; and
- SHA-256 over the canonical envelope.

The bounded operational projection contains counts, IDs, versions, decisions, and hashes only. It excludes claim text, finding spans, prompts, generated content, provider payloads, email content, and secrets.

### Integrity and drift

The shared verifier detects:

- unsupported envelope version;
- modified envelope content/hash;
- surface mismatch;
- Context Packet drift;
- policy-pack drift; and
- verifier-version drift.

Verification is not authorization. A destination service still recomputes its server-owned structural and release checks before persistence or release.

### Rollout boundary

Phase 16 uses exact:

```text
MERI_RELEASE_GATE=off|shadow|enforce
MERI_RELEASE_GATE_TENANTS=<comma-separated server tenant IDs>|all
MERI_RELEASE_GATE_SURFACES=<comma-separated exact surface names>|all
```

All three controls are required. Missing, invalid, truthy-looking, misspelled, or partially configured values resolve to `off`.

- `off` — no Phase 16 release behavior changes;
- `shadow` — computes the same frame, evidence plan, ledger, findings, gate, and envelope but leaves user/model output and applyable edits unchanged;
- `enforce` — buffers and releases, repairs, or holds only for the explicitly selected tenant and surface.

The browser cannot select mode, tenant, surface, Context Packet, policy binding, or release decision.

### Surface implementation

#### Chat and external chat-created deliverables

Full chat now resolves rollout from the authenticated `MeriContext.tenantId` and exact `chat` surface.

- low-risk conversational help continues normal token streaming;
- shadow evaluates the same evidence, claims, findings, gate, and envelope while leaving the reply and persisted actions unchanged;
- enforce buffers high-risk prose before release;
- model-authored memo/note bodies are checked before the persisting tool is invoked;
- page-write and artifact frames are withheld when the final release decision is `repair` or `hold`;
- bounded metrics contain mode, decision, category, jurisdiction, and envelope hash only.

The inherited chat test file still assumes the pre-Phase-16 one-switch rollout. It must be updated to arm all three controls and receive a fresh exact-head run; the production resolver is not weakened to satisfy that stale fixture.

#### In-editor

The in-editor assistant resolves mode from the authenticated `MeriContext.tenantId` and exact surface `in-editor`.

- shadow runs the complete verification path and returns the original edit set;
- enforce withholds unsupported high-risk edits before they become applyable;
- advice-only turns remain normal;
- server Context Packet state is used for evidence; browser-supplied verification is ignored.

#### Workspace

Workspace generation now creates one envelope per generated section. Legacy document-wide findings are attributed to the section containing their span when possible. PE structural findings are attributed by PE identity and the relevant claim language. Only genuinely unattributable conditions remain run-wide.

This closes the defect where one severe section could hold unrelated generated sections. The existing generation service remains dark unless all rollout controls are explicit; tenant-aware invocation must be used before a tenant-specific Workspace canary.

#### Strategy and Outreach document generation

Strategy/outreach document assessment now returns the canonical envelope with claim-ledger and provenance results. Shadow returns the original draft. Enforce may hold. Context Packet and persisted-policy bindings are supported and drift-verifiable.

The API Strategy destination treats the envelope as untrusted wire data, verifies version/hash/surface/timestamp/verifier/release-decision/ledger consistency, and independently recomputes structural context/provenance checks before staging a Workspace or Outreach artifact. A missing or tampered envelope is not releaseable once the destination gate is enforced.

#### Steward

Steward resolves rollout using the server tenant and the `steward` surface. Shadow records unsupported anchored facts without changing extraction output. Enforce withholds only unsupported high-risk facts, remaps conflict indices, and leaves unrelated facts intact. The envelope attributes findings to their exact extracted claim when possible.

### Permanent regression gate

`memory-governance-ci` is extended through Phase 16 and now includes:

- envelope integrity and drift tests;
- exact rollout parser/canary tests;
- shared assurance/risk-gate tests;
- full chat and in-editor service tests;
- Strategy and Steward envelope tests;
- API Strategy destination-side envelope verification;
- Workspace section-aware assurance tests; and
- all inherited Phase 1–15 database, memory, context, policy, worker, UI, and accessibility gates.

### Rollback

Set:

```text
MERI_RELEASE_GATE=off
MERI_RELEASE_GATE_TENANTS=
MERI_RELEASE_GATE_SURFACES=
```

This stops Phase 16 enforcement without deleting envelopes, findings, audit evidence, Context Packets, or policy records. Do not delete evidence or rewrite release decisions as rollback.

---

## Acceptance status

Phase 16 is **not accepted yet**. Acceptance requires:

1. update and pass the inherited chat test suite under the three-control rollout contract;
2. focused and cumulative validation on one exact synchronized head;
3. shadow evidence from an internal tenant showing no output changes;
4. a reviewed false-positive sample for each canaried high-risk surface;
5. zero broad low-risk refusal regression;
6. zero cross-tenant or browser-forged authority acceptance; and
7. successful rollback to shadow/off.

GitHub attempted validation on the implementation head but produced a zero-job `startup_failure` under the repository's orphan `BuildFailed` workflow identity. No legitimate job ran, so no test, typecheck, build, or canary result is claimed.

No internal or production flags were enabled during implementation. No customer data, production migration, AWS resource, external communication, or production environment was changed.
