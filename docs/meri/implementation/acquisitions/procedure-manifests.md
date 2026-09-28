# H5 procedure-manifest acquisition

## Source pin

The Commitments & Deliverables canonical procedure adapts two playbooks from:

- Repository: `NousResearch/hermes-agent`
- Commit: `516535b54275e963a82b4c28f866338fb768e7bc`
- `skills/productivity/meeting-action-items/SKILL.md`
- `skills/productivity/document-to-action-items/SKILL.md`

The pin is intentionally immutable. A future upstream review must record a new
pin rather than silently following a branch or tag.

## Adaptation mapping

The local server-owned recipe is implemented in
`apps/api/src/meri/skills/commitments-audit.procedure.ts`. It adapts these H5
playbook concepts into declarative procedure data:

- separate evidenced commitments from decisions, proposals, questions,
  blockers, and suggestions;
- retain source locators and citations;
- represent unsupported owner and due-date values as `unknown`;
- preserve obligation modality such as may, should, and must;
- deduplicate repeated promises while retaining evidence;
- distinguish tracked work from delivery or acceptance evidence; and
- keep read-only audit guidance separate from any approved write action.

No upstream scripts or execution engine are imported by this slice. The
canonical guidance and procedure clauses are immutable; tenant configuration
remains available through the presentation template and supported extra
read-only tools. Validation and resolution require the protected clauses from
the server-owned recipe.

## License and distribution

The pinned upstream repository is MIT licensed, Copyright (c) 2025 Nous
Research. `THIRD_PARTY_NOTICES` identifies both this H5 adaptation and the
existing H1 runtime-guardrails adaptation, and retains the complete MIT
permission, condition, and warranty text for distribution.

This acquisition record documents provenance and adaptation boundaries; it is
not evidence that served procedure binding or CD-01 through CD-07 have run.
