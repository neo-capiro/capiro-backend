# Workspace Two-Screen Flow — Review Checklist

## Product

- [ ] `/workspace/new` shows one intake screen rather than a multi-step wizard.
- [ ] Goal, client, published template, relevant context, client saved docs, sample docs, and Capiro context are visible together.
- [ ] Firm template creation still routes to Template Studio.
- [ ] The next durable route after generation is `/workspace/:draftId`.
- [ ] The existing Meri/editor/collaboration surface is preserved.

## Grounding

- [ ] Sample documents never appear in persisted factual evidence IDs.
- [ ] Unresolved system-context requests never appear in persisted factual evidence IDs.
- [ ] The selected client profile is included as actual context when requested.
- [ ] Context conflicts remain visible and unresolved.
- [ ] Delivery remains blocked by existing conflict/quality policy.

## Generation

- [ ] The endpoint verifies the pinned blueprint is published.
- [ ] `expectedRevision` is checked before work begins.
- [ ] `updatedAt` protects the final long-running save.
- [ ] Brief, context analysis, outline, Max plan, section draft, and editorial pass are invoked.
- [ ] `config.sectionContent` contains sanitized editable HTML.
- [ ] Agent state lands in `phase: draft`, `generation.mode: max`.
- [ ] Transcript persistence failure cannot invalidate a saved draft.

## Files and context

- [ ] Text file limits are enforced and truncation is visible.
- [ ] PDF/DOCX are not falsely presented as parsed.
- [ ] Saved Workspace docs are bounded before submission.
- [ ] Prompt packet has a total character budget.
- [ ] Cross-service context requests are marked unresolved/non-factual.

## Regression

- [ ] Legacy Workspace routes are unchanged.
- [ ] Existing `/workspace/:draftId` editor still loads.
- [ ] Existing Template Studio still loads.
- [ ] Public share route is untouched.
- [ ] No migration or schema change is required.

## Required gates

- [ ] Workspace Prisma generate
- [ ] Workspace typecheck
- [ ] Workspace tests
- [ ] Workspace build
- [ ] Web typecheck
- [ ] Web tests
- [ ] Web build
- [ ] `git diff --check`
- [ ] Authenticated browser smoke test
- [ ] Real Max draft smoke test against configured MeriV3 orchestrator
