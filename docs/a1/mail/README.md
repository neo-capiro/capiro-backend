# A1 Mail safety handoff

Scope: ML-02, ML-03, ML-07, ML-08, ML-09, ML-10 and X-04. No live provider sends, AWS changes, merges, runtime enablement or deployment occurred. Neo's explicit OAuth/token approval was relayed before those protected edits; the detailed OAuth evidence and file list are in `../oauth-approval/README.md`.

## Implemented boundaries

- Graph retries only GET. Mutation POSTs, including draft/send, are never automatically replayed for Retry-After/429/5xx. The real HTTP-helper tests cover rejection, server error, transport loss, unclassified error, malformed draft receipt and 202 no-content acceptance. Only explicit provider HTTP rejection receives the definite-failure marker.
- A durable single-mail intent binds tenant, actor and request UUID to a canonical request hash and an immutable rendered snapshot. This includes mailbox, reply thread, recipient groups including Bcc, signature selection, body and attachment IDs/content hashes. Atomic pending-to-sending claims precede the provider call. Accepted, unknown and definitely rejected outcomes persist independently of later access revocation; receipt reads repeat current access checks. Sending/unknown/pending identities are never reset or replayed automatically.
- Current membership, mailbox ownership, readable/unarchived client, person association, thread ownership/client association, attachments and source distribution are checked before dispatch, with a second admission after attachment byte loading and immediately before claim. Null-client recipient-derived history uses the existing association predicate. Acceptance followed by revocation retains the outcome while withholding details.
- Sync persistence and removal reject provider IDs already associated with another mailbox. Database mutation selectors also include mailbox lineage; removal verifies message/thread lineage and scopes summary recomputation. Synthetic collision/interleaving tests qualify these predicates. The existing tenant/provider ID uniqueness schema remains: colliding mailboxes fail closed instead of being silently reassigned. A complete mailbox-key migration remains a separate Fable-owned gate.
- OAuth add/reconnect and refresh changes are documented in the separate OAuth handoff. They use existing connection state and token snapshot fencing; no new auth/session layer or Meri internals were changed.

## Migration and lifecycle gate

`single-mail-intents.sql` is an **unnumbered proposal**, not an applied migration. Fable owns numbering, inspection and deployment order. It must land before ordinary staging deploy of this code. The intent table has tenant RLS and the existing `app.current_tenant` setting. Authorized tenant destruction cascades its sensitive snapshot. Actor/client/mailbox lineage is immutable UUID data without individual foreign keys, so deleting a mailbox or identity cannot erase a duplicate-send fence. Current domain admission prevents inaccessible receipt reads. The PGlite test checks the SQL claim, duplicate/conflicting request, actor/tenant scope and deletion lifecycle; native PostgreSQL RLS/locking/contention remains unqualified.

The new read route is `GET engagement/mail/send-intents/:requestKey`. The engagement route inventory is regenerated from the repository generator and includes this read route. Generated inventories were not hand-edited; the review revision records the generator results. The paired frontend sends the required UUID and recovers only the same owned intent across reloads/tabs. Old clients without a UUID fail closed; deploy frontend/backend/migration in a reviewed sequence.

## Verification and limits

Final restored validation: **15 suites / 190 tests passed**, including both Mail and OAuth. `final-green.json` records every case. All **32** new/changed non-OAuth cases killed a relevant mutant across **18** mutations (`test-mutation-map.json`); all **49** new OAuth cases are qualified separately.

`mutation-evidence.json` maps the non-OAuth tests to deliberately reintroduced defects. All sources were restored after every mutation. `baseline-direct-api.json` records the direct HTTP regressions against the pre-fix service; the current DTO/controller harness admits the same request shape so provider-boundary behavior is compared. The real Nest harness retains controller DTOs and RolesGuard, supplies the trusted tenant-context seam, and calls the real service. Auth middleware/global runtime admission, external providers and unrelated document/AI constructors are outside this harness.

Focused verification uses mocked providers; it is not a production send test. The ledger suite uses cached PGlite 0.3.7 instead of locked 0.5.8. The local runtime uses cached Jest 29/ts-jest with transpile-only diagnostics, and some unrelated imports are mocked because the full dependency set is unavailable. Existing legacy projection/attachment fixtures were adapted for the durable ledger and extra current-access reads, but their broad suites still require a normal locked dependency install (including sanitizer/SDK dependencies). Full build/typecheck, native PostgreSQL races/RLS, browser staging and provider staging remain Fable qualification gates. Current pending/sending/unknown requests require review/reconciliation; no background resolver or automatic retry was added.

## Change-controlled source files

- `apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts` (transport, persistence and approved token regions).
- `apps/api/src/engagement/microsoft/microsoft-oauth.service.ts`.
- `apps/api/src/engagement/google/google-sync.service.ts`.
- `apps/api/src/engagement/google/gmail-send.service.ts` (bounded outcome classification).
- `apps/api/src/engagement/google/google-oauth.service.ts`.
- `apps/api/src/engagement/google/google-token.service.ts`.
- `apps/api/src/engagement/mailbox-oauth-authority.ts` (new shared OAuth/token authority helper).

`engagement.service.ts` contains the single-mail methods only for this area; Portfolio's meeting changes must be integrated separately. Schema rollout, merge and live qualification remain held for the coordinating owner.

The focused reproducible config is checked in at `docs/a1/mail/jest.config.cjs`. Its inert MSAL module refuses unexpected client construction; OAuth specs provide their explicit synthetic MSAL implementations. From the backend root, run the listed A1 suites and provider regressions with:

```sh
node --experimental-vm-modules --max-old-space-size=1024 node_modules/jest/bin/jest.js --config docs/a1/mail/jest.config.cjs --runInBand --runTestsByPath apps/api/src/engagement/single-mail-service.a1.spec.ts apps/api/src/engagement/single-mail-safety.a1.spec.ts apps/api/src/engagement/single-mail-ledger.a1.spec.ts apps/api/src/engagement/mailbox-persistence.a1.spec.ts apps/api/src/engagement/microsoft/microsoft-graph-sync.retry.spec.ts apps/api/src/engagement/mailbox-oauth.a1.spec.ts apps/api/src/engagement/mailbox-oauth.a1.http.spec.ts
```

## Review revision and explicit policy holds

Neo declined new email functionality in the 2026-10-21 decision relayed in meri-greenfield #202, comment 6328397030. No explicit unknown-send release/start-new-email action is implemented. Pending, sending and unknown attempts remain fenced; no automatic release or resend is introduced.

The proposed ML-09 collision hold/continue/cursor-advance behavior is still awaiting a bounded decision. The existing fail-closed identity guard remains unchanged, including the known re-added-mailbox sync stall; this is an open review blocker, not a completed ticket. The mailbox-qualified identity migration remains separate.

Authorized mechanical regressions are repaired: OAuth Add reuses a fresh, tokenless, history-free row under serialization and row-lock checks; repeated starts replace the nonce instead of creating visible orphan rows. Replay/removal fixtures carry the intended mailbox identity. `review-r1-mechanical.md` and its JSON receipts distinguish focused 75/75 behavioral verification and killed mutants from the canonical API Jest run blocked before collection by unavailable cached dependencies. No dependency was added, provider contacted or SQL executed.
