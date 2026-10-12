# Capiro memory wording handoff to the existing source owner

Source: coordinator user message in this task; Meri PR12 at
90b4dc8472da13cdee9f49cdc0b4c8306ecbdc73. The complete supplied handoff follows.

Status: ready for the capirov2 owner; not implemented by the Meri backend owner.
Neo approved retaining the existing administrator self-approval exception. This
handoff supplies exact affected public strings, not private producer bodies.

Both files below are byte-identical between reviewed policy reference
`fd8765ec01d292013758606204f2c9d886cd31c1` and the observed local capirov2 head
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. Recheck the owner's current head before
editing. No capirov2 or frontend file was changed in this workstream.

## Exact contradictions and replacement text

`apps/api/src/memory/memory-candidate-rules.ts:112–113`, existing
`memory.firm.requires_approval` reason, joined string:

> Firm-wide memory requires an authorized reviewer other than the proposer before it becomes shared truth.

Replace that reason with:

> Firm-wide memory remains pending until an authorized administrator approves it. An authorized administrator may approve their own proposal.

Same file, lines 124–125, existing `memory.client.requires_approval` reason:

> Client-scope memory requires an authorized reviewer other than the proposer before it steers client work.

Replace that reason with:

> Client-scope memory remains pending until authorized approval. An authorized administrator may approve their own proposal; other reviewers must be different from the proposer and satisfy the existing grant and assignment requirements.

Reconcile the same file's entire comment block at lines 56–79: lines 57–58 promise
universal independent review, lines 67 and 71 promise a second human and prohibit
an administrator ratifying their own proposal, and lines 75–77 categorically
prohibit self-ratification. Distinguish mandatory pending creation from the
subsequent administrator approval exception. Preserve the historical prohibition
on automatic promotion in one request. The comments around client scope also
must not promise an unconditional independent-review requirement.

`apps/api/src/meri/meri-tools.service.ts:2954`, existing pending response message:

> I've proposed this as ${pendingLabel === 'client' ? 'client-scope' : 'firm-wide'} memory; another authorized reviewer needs to approve it before it becomes shared truth. I can save it as your personal memory right now instead — just say so.

Use scope-specific replacement text in that same `message` field:

- Firm: “I've proposed this as firm-wide memory. It remains pending until an authorized administrator approves it; an authorized administrator may approve their own proposal. I can save it as your personal memory right now instead — just say so.”
- Client: “I've proposed this as client-scope memory. It remains pending until authorized approval. An authorized administrator may approve their own proposal; other reviewers must be different from the proposer and satisfy the existing grant and assignment requirements. I can save it as your personal memory right now instead — just say so.”

Correct the same file's comments at line 2906 and lines 2950–2952, which currently
promise a different reviewer and disallow an administrator approving their own
proposal. Preserve the personal-memory alternative as an offer requiring a
separate user request, not an automatic alternate save.

## Precise contract effect and verification

This changes the semantics of the existing human-readable `reason` and `message`
strings. It needs no JSON shape, field, rule ID, status, endpoint or Meri public
0.1 contract change. Pending replies remain `{ saved: false, scope,
candidateId, message }`. Both shared rules retain `WARN`; administrators' new
shared proposals still start pending. Do not restore automatic administrator
commit or turn descriptive wording into an authorization evaluator.

The exact administrator roles remain `user_admin` and `capiro_admin`. Existing
current tenant/client/wall authorization still applies. Ordinary grants do not
permit firm approval. Ordinary client reviewers still need current grants,
assignment and a different proposer. Administrators need not be the assigned
reviewer. The approval exception does not extend to shared self-rejection or
withdrawing another person's proposal. Private-owner behavior and review for
automated `model_extraction`/`learning_signal` candidates stay intact.

The existing source owner should update text assertions and retain behavioral
controls for pending creation, admin own/other approval, non-admin firm denial,
ordinary client grant/assignment/nonself requirements, current authorization,
self-rejection versus withdrawal, and automated review. Meri's independently
reviewed descriptive source is `packages/contracts/retrieval-0.2/memory-review-policy.mjs`
at preserved PR11 `5db2714b6dcbd3109c528e0afafcb654216133ca`; it grants no authority
and is not a substitute for capirov2's canonical enforcement.
