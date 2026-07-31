# MeriV2 World-Class Closeout — Phase 14 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Phase 13:** Focused local/disposable-PostgreSQL acceptance passed on `26db7ca83c066d4a9464e263e86650d7db0a58a1`  
**Phase 14:** Implemented; exact-head automated and manual accessibility validation pending

This ledger continues the accepted work log and prior addenda. It does not authorize merge, deployment, migration, feature activation, customer-data change, external send, or production rollout.

---

## Phase 14 — Context Inspector identity and accessibility

### Audit closure

Every inspector previously reused the fixed IDs `trust-context-included` and `trust-context-excluded`. Rendering more than one inspector on a page therefore produced duplicate IDs and ambiguous `aria-labelledby` relationships.

Unknown authority values also fell through to raw internal slugs, and focus treatment depended on whichever parent surface happened to load chat-specific CSS.

### Implemented identity boundary

`ContextInspector` now uses React `useId()` to create one unique namespace per mounted instance. The namespace covers:

- disclosure summary;
- disclosure body;
- Included heading;
- Excluded heading; and
- degraded-state announcement.

Every `aria-labelledby` and `aria-controls` reference is instance-local and unique.

### Disclosure and assistive-technology behavior

The component retains native `<details>/<summary>` semantics while explicitly synchronizing:

- `open` state;
- `aria-expanded`;
- `aria-controls`; and
- mouse/touch `onToggle` changes.

Enter and Space toggle the disclosure without changing focus. The summary accessible label includes included/excluded counts and degraded state. Degraded content uses assertive live announcement; missing context uses a polite status announcement.

### Focus visibility

A component-scoped stylesheet is imported directly by `ContextInspector`. It supplies a visible focus outline for the summary and **Review context** button across chat, Workspace, and future inspector surfaces rather than relying only on chat-container focus rules.

### Confidentiality and human-readable values

Restricted exclusions remain aggregate-only. Authorization, wrong-client, and sensitivity-denied exclusions never expose their IDs, labels, types, or other identity metadata.

Known authority values use controlled plain-English labels. Unknown authority values render as **Unknown** and never expose the internal slug.

### Automated gate

The existing Context Inspector suite is expanded to cover:

- multiple-instance ID uniqueness;
- exact `aria-labelledby` resolution;
- exact `aria-controls` resolution;
- Enter/Space toggling;
- synchronized `aria-expanded`;
- bounded screen-reader summary labels;
- degraded and missing-state announcements;
- automated axe validation;
- aggregate-only restricted exclusions;
- known and unknown authority rendering;
- unknown lifecycle rendering; and
- durable packet-ID fail-closed behavior.

`memory-governance-ci` is extended through Phase 14 and retains this test in the cumulative web matrix.

Detailed contract:

```text
docs/qa/meriv2-phase-14-context-inspector-accessibility.md
```

### Deterministic manual gate

A development-only fixture renders two inspectors without authentication or API dependencies:

```text
http://127.0.0.1:5173/context-inspector-a11y-fixture.html
```

It includes normal, degraded, restricted, known-authority, unknown-authority, unknown-lifecycle, and **Review context** states. This makes the keyboard, focus, heading, confidentiality, and screen-reader checks repeatable on the exact validation head.

The fixture is not linked from the product and exists only for manual QA.

### Rollback

There is no data rollback. Revert the Phase 14 component, test, component-scoped stylesheet, and manual fixture if a rendering regression appears. Do not mutate context packets, governed memory, exclusions, or audit evidence as rollback.

---

## Current gate

Phase 14 is not accepted until its focused automated suite and manual accessibility checklist pass on one exact synchronized head.

GitHub-hosted replication remains separately blocked by the orphan `BuildFailed` Actions identity.

Phase 15 has not started.
