# MeriV2 Phase 14 — Context Inspector Identity and Accessibility

## Status

**Local exact-head accessibility acceptance passed on `d87b4db1d18f4d5503dfcca751e3c36e784423bf`.**

The acceptance includes keyboard/focus verification, deterministic fixture inspection, ARIA relationship verification, production build, and automated axe coverage. A live NVDA or Windows Narrator audio session was not available in the validation environment; that remains a documented residual accessibility verification item rather than an unreported claim.

Phase 14 closes the duplicate-ID and accessibility defects in the cross-surface Context Inspector without changing context selection, packet persistence, authorization, or customer data.

## Identity contract

Every `ContextInspector` instance creates its own React `useId()` namespace. The namespace supplies unique IDs for:

- the disclosure summary;
- the controlled disclosure body;
- the Included heading;
- the Excluded heading; and
- the degraded-state announcement.

Every `aria-labelledby` reference resolves to one existing element in the same rendered tree. Rendering multiple inspectors on one page cannot duplicate these IDs.

## Disclosure and keyboard contract

The inspector remains a native `<details>/<summary>` disclosure. The component synchronizes the open state so assistive technology receives truthful disclosure metadata:

- `aria-controls` points from the summary to the exact body;
- `aria-expanded` matches the actual disclosure state;
- Enter toggles the inspector;
- Space toggles the inspector; and
- mouse/touch disclosure changes remain synchronized through `onToggle`.

The summary and the optional **Review context** button receive a visible three-pixel focus outline through component-scoped CSS. The stylesheet is imported by the inspector itself so the focus treatment is available in chat, Workspace, and any other surface that renders the component.

## Screen-reader contract

The summary has one bounded accessible label containing:

- the caller-provided inspector label;
- included item count;
- excluded item count when nonzero; and
- degraded-state notice when applicable.

A degraded packet is announced through `role="alert"`, `aria-live="assertive"`, and `aria-atomic="true"`. A missing packet remains a polite status announcement.

## Confidentiality contract

Exclusions caused by authorization, wrong-client scope, or sensitivity remain aggregate-only.

The inspector may display only:

- the aggregate restricted-item count; and
- the statement that identity was withheld by access controls.

It must not render a restricted item's ID, label, type, or other identity-bearing metadata. This behavior is unchanged by the new accessibility labels.

## Human-readable authority contract

Known authority values use the controlled plain-English label map. Any authority value not present in that map renders as:

```text
Unknown
```

The raw internal slug is never echoed to the user. Unknown lifecycle values follow the same `Unknown` behavior.

## Automated regression coverage

`ContextInspector.test.tsx` proves:

- multiple inspectors generate globally unique DOM IDs;
- every `aria-labelledby` reference resolves to exactly one element;
- Enter and Space synchronize open state and `aria-expanded`;
- the summary exposes a bounded screen-reader label;
- `aria-controls` resolves to the exact disclosure body;
- degraded state is assertively announced;
- missing context is politely announced;
- automated axe checks report no violations in the expanded state;
- restricted identities remain absent while aggregate counts remain visible;
- known authority slugs receive plain-English labels;
- unknown authority and lifecycle slugs are not rendered;
- durable packet IDs remain fail-closed; and
- the review button remains a link to the governed review surface rather than an inline canonical edit.

The permanent `memory-governance-ci` web matrix includes this test file.

## Manual accessibility fixture

A development-only fixture is available at:

```text
http://127.0.0.1:5173/context-inspector-a11y-fixture.html
```

It renders two inspectors without authentication or an API dependency:

- a normal inspector with included/excluded items, one restricted aggregate, a known authority, an unknown authority, an unknown lifecycle, and **Review context**; and
- a degraded inspector with assertive announcement content.

The fixture files are:

```text
apps/web/context-inspector-a11y-fixture.html
apps/web/src/components/trust/ContextInspector.a11y-fixture.tsx
```

They exist only to make manual accessibility inspection deterministic and are not linked from the application.

## Acceptance evidence

Fresh validation on `d87b4db1d18f4d5503dfcca751e3c36e784423bf` passed:

- frozen dependency install;
- shared package build;
- web typecheck;
- web production build;
- Context Inspector suite: 14/14 tests;
- expanded-state axe scan;
- Phase 14 Prettier surface;
- `git diff --check`;
- clean working tree;
- two fixture inspectors rendered;
- visible summary and Review-context focus treatment;
- Enter and Space expand/collapse;
- focus retention after toggling;
- distinct Included and Excluded headings;
- aggregate-only restricted exclusion;
- unknown authority and lifecycle labels rendered as `Unknown`; and
- PR #679 remained draft, open, mergeable, synchronized, and unmerged.

Validation log:

```text
C:\Users\neoma\phase14-automated-validation.log
```

### Residual verification item

No live NVDA or Windows Narrator audio session was run. Announcement behavior was verified through `aria-label`, native disclosure semantics, `role="alert"`, live-region attributes, unique IDs, `aria-controls`, axe, keyboard behavior, and DOM inspection. A later release-candidate accessibility pass should include one live assistive-technology session, but it does not block Phase 15 implementation.

## Rollback

No data rollback exists or is required.

If the inspector has a rendering regression, revert the Phase 14 component, test, component-scoped stylesheet, and manual fixture changes. Context packets, governed memory, audit evidence, and authorization records remain untouched.

Do not alter packet data or restricted exclusion evidence as a UI rollback mechanism.

## Production boundary

Phase 14 does not authorize merge, AWS deployment, migration, feature-flag activation, customer-data mutation, external send, or production rollout.
