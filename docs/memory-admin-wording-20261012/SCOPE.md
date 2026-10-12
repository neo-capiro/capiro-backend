# Institutional Memory wording alignment

Source-only candidate, based on main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`; independent of PR2393/2394/2395
and the Core activity command candidate. No frontend or meri-greenfield edits.

Neo approved retaining the existing administrator self-approval exception. The
exact wording handoff is published in Meri PR12 at
`at90b4dc8472da13cdee9f49cdc0b4c8306ecbdc73` as supplied by the coordinator
(the supplied token has a non-hex prefix; the replacement text itself was supplied
in full and is the source for this bounded edit). Descriptive policy reference is
Meri PR11 `5db2714b6dcbd3109c528e0afafcb654216133ca`, not enforcement authority.

Rechecked both targeted capirov2 files: byte-identical between policy reference
`fd8765ec01d292013758606204f2c9d886cd31c1` and current main above:
`apps/api/src/memory/memory-candidate-rules.ts` and
`apps/api/src/meri/meri-tools.service.ts`.

Change only the two shared-memory reason strings, the scope-specific pending
message, contradictory comments, and characterization assertions. Preserve rule
IDs, WARN outcomes, pending creation, response JSON, personal-memory alternative
as an offer, and automated review. Do not modify canonical roles, evaluators,
grant/assignment checks, approval/rejection/withdrawal behavior, current tenant
or client/wall authorization. No live state, schema, migrations or deployment.

Independent review and focused existing behavioral controls must verify admin
own/other approval, ordinary firm denial, ordinary client grant/assignment/nonself
requirements, current authorization, self-rejection versus withdrawal, private
ownership and model_extraction/learning_signal review. This candidate describes
existing authority; it creates none.
