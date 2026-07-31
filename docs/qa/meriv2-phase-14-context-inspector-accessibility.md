# MeriV2 Phase 14 — Context Inspector Identity and Accessibility

## Status

**Implemented; exact-head automated and manual accessibility validation pending.**

Phase 14 closes the duplicate-ID and accessibility defects in the cross-surface Context Inspector without changing context selection, packet persistence, authorization, or customer data.

## Identity contract

Every `ContextInspector` instance now creates its own React `useId()` namespace. The namespace supplies unique IDs for:

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

The raw internal slug is never echoed to the user. Unknown lifecycle values continue to follow the same `Unknown` behavior.

## Automated regression coverage

`ContextInspector.test.tsx` now proves:

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

## Manual acceptance checklist

On the exact validation head:

1. Render at least two inspectors on one page.
2. Tab to each summary and verify a clearly visible focus outline.
3. Press Enter to expand and collapse each inspector.
4. Press Space to expand and collapse each inspector.
5. Confirm focus does not move unexpectedly.
6. With a screen reader, verify the summary announces the inspector label, included count, excluded count, and degraded state when present.
7. Expand a degraded inspector and verify the degraded message is announced.
8. Confirm Included and Excluded headings are navigable and uniquely identified.
9. Confirm restricted exclusions expose only an aggregate count.
10. Confirm an unknown authority is spoken and displayed as “Unknown,” not as its internal slug.

## Acceptance gate

Phase 14 passes only when:

- web typecheck passes;
- the Context Inspector test suite passes, including axe;
- multiple-instance ID and ARIA reference tests pass;
- keyboard and focus checks pass manually;
- screen-reader checks pass manually;
- formatting and diff integrity pass;
- the working tree is clean; and
- PR #679 remains draft, open, mergeable, synchronized with `main`, and unmerged.

## Rollback

No data rollback exists or is required.

If the inspector has a rendering regression, revert the Phase 14 component, test, and component-scoped stylesheet changes. Context packets, governed memory, audit evidence, and authorization records remain untouched.

Do not alter packet data or restricted exclusion evidence as a UI rollback mechanism.

## Production boundary

Phase 14 does not authorize merge, AWS deployment, migration, feature-flag activation, customer-data mutation, external send, or production rollout.
