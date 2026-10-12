# Independent saved newsletter staging source review

Accepted source: `77e8323527d5ed533aa084cb8865f4b2d75f9958`.
Tree: `fd813d3ecf5937f1eebcc498af244f612bcdb61b`.
Required preserved base: PR2400 `6c26ac2dad3756a61b6733329dea7ce3c9138ece`.
Original audited source: `fcea81c0f1bda36c658d47def1abb9e7ccaf80a2`,
tree `37720720b96f8f6c7da3e68e15082a58ca108967`.

No remaining source blocker was found in the accepted slice. This is independent
source review with synthetic tests; it is not native PostgreSQL, RLS, migration,
provider, or deployment acceptance. The reviewer changed only this evidence
directory and a temporary original-source helper outside tracked implementation.
No implementation, branch, permission, credential, database, AWS, customer data,
message, upload, or paid-model operation was performed.

## Findings and corrections

1. **P1 — locking immutable source receipts requires a forbidden privilege.**
   The original helper used `FOR SHARE` on `ws_source_action`. Existing Workspace
   migration `20260913020000_legiwatch_preparation_actions` grants SELECT/INSERT
   and revokes UPDATE/DELETE/TRUNCATE. Row-locking SELECT also requires UPDATE
   privilege, as specified by the [PostgreSQL SELECT documentation](https://www.postgresql.org/docs/15/sql-select.html).
   Under that role, the original helper could fail even for an ordinary draft
   with no source receipt. The author removed only this row lock. Canonical
   source creation inserts a new draft and immutable source receipt atomically;
   no canonical receipt-attachment path to an existing draft was found. Mutable
   tenant, member/user, draft, version, client and grant locks remain.
2. **P1 — legacy client context was silently treated as firm content.**
   Workspace creates display-name `config.client` and `draft.client`, and
   generation resolves that name to client steering through the canonical
   compiler. The original helper checked only `config.clientId`. Thus saved
   `client`, `clientAssociated`, or `clientPersons` context without that UUID
   could be staged into a firm session without a client wall decision. The
   author now rejects those saved/current legacy hints, including promoted
   `draft.client`, unless the exact saved/current canonical client UUID exists.
   There is no name inference or new client binding store.
3. **P1 — chooser disclosure preceded source-owner client authorization.**
   The original Workspace saved-revision route could return full snapshot and
   content projection under draft collaboration alone even with a declared
   canonical client whose wall denied the caller. The author now resolves the
   current Clerk subject to Core UUID, sets that exact user transaction context,
   locks/rechecks the same-tenant nonarchived client and actual grant, and calls
   the canonical shared wall predicate before either chooser disclosure or
   staging. Core additionally checks the current Outreach sponsor and canonical
   capability owner; draft ownership and admin status cannot bypass the wall.
4. **P1 — preparation and unknown receipt origins exceeded this bounded slice.**
   The original source restriction denied research/editorial receipts while
   admitting preparation/unknown origins. Preparation attaches private folder
   context for grounding; later section edits can reflect that context. The
   author now denies every immutable `ws_source_action` origin, preserving the
   first slice's ordinary-draft distribution boundary. Prospect drafts remain
   ineligible. Any future source-backed distribution needs its own explicit
   authorization contract.

All four findings are corrected in the accepted head. The original helper
regression retains **9 failed / 21 passed** tests, demonstrating the permission,
legacy-client, chooser-wall/lifecycle, and source-origin defects. Its command
engine source is byte-identical to the accepted engine source; only the helper
was substituted from the pinned original Git blob during that run.

## Independent evidence

`adversarial.spec.ts` contains **40 passing independent synthetic tests**. The
self-contained Jest runner consumes the actual helper TypeScript source and
the canonical command engine source, rather than relying on a stale shared
build. The helper override is used only to reproduce the original rejected
source. `reviewed-source.json` pins Git blob IDs and SHA-256 hashes of the eleven
incremental source paths.

The tests challenge tenant/member revocation, actual Clerk/UUID agreement,
unsupported roles, source ACL revocation, saved version tenant/draft binding,
deleted source recovery, changes outside the plain-text projection, canonical
client wall/lifecycle and source reassignment, exact request identity, ordinary
command namespace collision, changed receipt provenance, duplicate and stale
synthetic requests, receipt-readback rollback, no-change staging receipts,
strict input, bounded content, slot rejection, current-user context binding,
and mutable-authority lock statements. Successful calls use only a literal
`SET_CONTENT_SKELETON` command and the existing append-only Outreach receipt.
No provider/upload/generation/session-creation API is present in that call graph.

The final direct locks compose with the existing session `FOR UPDATE`, current
state-version CAS, unique session/batch receipt index, and append-only Outreach
state/event migration source. Exact retries recheck current source/client
authority before retrieving a prior receipt; changed expected version, source
identity, snapshot hash, author provenance or command identity cannot upgrade
or alter a consumed receipt. A saved snapshot cannot be updated under the new
Workspace migration source; existing delete/cascade behavior remains, and a
deleted source cannot be restaged.

Retained logs include the original rejected-source regression, the initial
30-test passing corrected-source run, the final 40-test passing run, and the
self-contained-runner verification. Setup/fixture mistakes are also retained:
`setup-resolution-failure.log` (transform lookup),
`fixture-sponsor-failure.log` (undecided fixture sponsor),
`fixture-target-field-failure.log` (wrong target property), and
`fixture-lock-selector-failure.log` (canonical wall subquery incorrectly included
in the direct-lock assertion). Those are reviewer harness failures, not additional
product findings. The canonical wall predicate is a plain query after the actual
client/grant locks are already held; the final assertion checks those direct locks.

Run from the repository root:

```bash
node apps/api/node_modules/jest/bin/jest.js \
  --config docs/newsletter-staging-20261012/evidence/independent-review/jest.config.cjs \
  --runInBand --no-cache
```

To reproduce the rejected helper, extract its exact original Git blob to a
temporary file and set `NEWSLETTER_REVIEW_HELPER_SOURCE` to that file for the
same command. The original thirty-test run occurred before the ten extra positive
client/bounds checks were added; the retained test file is the final superset.

## Remaining qualification gates

Native PostgreSQL/RLS/transaction-lock and concurrent revocation behavior has not
been tested. No database or migration has been executed, including ephemeral
databases. The original native Prisma download/egress restriction remains; no
bypass, alternative binary, or checksum disabling was used. Real capiro_app
grants, shared-schema availability, trigger installation, receipt constraints,
deadlock behavior, and source deletion/revocation races require the authorized
native qualification gate. Full Core TypeScript and Workspace checks are the
author's separately retained evidence; this reviewer ran the independent
synthetic suite with isolated transpilation and makes no independent full-build
or live-database claim.

The accepted source is suitable for a draft PR with those explicit gates. It
does not authorize merges, deployment, real messages, uploads, or generation.
