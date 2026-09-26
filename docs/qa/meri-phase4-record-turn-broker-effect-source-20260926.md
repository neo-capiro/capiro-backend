# Phase 4 `meri_record_turn` broker-effect source receipt

Date: 2026-09-26 (America/New_York)

## Outcome

The provisional integration contains a dormant, unregistered PostgreSQL authority for the
transactionally local `meri_record_turn` broker effect. A stable operation UUID serializes exact
retries; one successful effect performs one budget increment and one internal event in the same
transaction, while Stop, terminal state, policy, budget, current authorization, worker route, and
binding checks fail closed before the effect.

Committed and denied outcomes require an externally verified Ed25519 attestation over the exact
canonical effect claims. `effect_unknown` is deliberately unsigned and remains non-authoritative
uncertainty evidence. This package installs no signer/verifier writer, LOGIN role, runtime caller,
Nest registration, transport, scheduler, key, or credential.

## Security properties qualified locally

- Dedicated memberless NOLOGIN operator/signer roles, FORCE RLS, append-only operation,
  attestation, and receipt rows, no direct operator table authority, and no PUBLIC routine access.
- Operation UUID is the idempotency identity. Equal payloads may be legitimate distinct
  operations; changed identity under one operation UUID hard-conflicts.
- Concurrent exact retries serialize before operation lookup and replay one immutable receipt.
- The run row serializes budget/event effects with Stop and terminalization. The tenant authority
  fence serializes the decision with every relevant membership, tenant/user, client/access,
  mailbox, conversation, scope, and route writer.
- The routine independently reconstructs current membership, accessible client IDs, actor-owned
  mailbox IDs, the exact `m4a2` authorization digest, active conversation, envelope arrays and
  actor context, DB-time validity windows, source-qualified worker route/binding, and explicit
  `readOnly: false` tool policy.
- The TypeScript boundary accepts only fixed identity/request/disposition inputs, uses fixed SQL
  after `SET LOCAL ROLE`, verifies the effective principal, and independently verifies the exact
  Ed25519 claim signature against a pinned public-key registry. Malformed, ambiguous, unsigned
  committed/denied, or unverifiable output becomes `effect_unknown`.

## Verification

The final source gate passed 3 suites / 29 tests plus targeted TypeScript. Prisma validation and
`git diff --check` passed.

The disposable PostgreSQL rehearsal applied all 443 API migrations after exercising the expected
PUBLIC-routine negative control and passed 1 suite / 7 tests. It covered exact replay, changed
identity/cross-tenant rejection, Stop-first/effect-first ordering, terminal/revoked/stale-route and
worker mismatch denial, two-connection concurrency, operator least authority, append-only rows,
DB-time attestation windows, and retention.

The earlier recovery package was requalified on the same 443-migration head: 15 suites / 116
source tests and 3 suites / 18 database tests passed. B1/B3/B6 requalification passed 6 database
suites / 28 tests, including all 443 API migrations and 61 intel migrations. One transient first
B1/B3/B6 container-start race failed before schema creation; the clean rerun passed in full.

## Bounded Hermes review

A read-only Hermes audit used `openai/gpt-5.6-luna` through OpenRouter with low reasoning. It made
4 model calls, reported 71,481 total/cache/reasoning tokens, and estimated USD 0.01411296. This is
approximately 44.7% of a 160k context window, below both the 45% stop target and the user's 50%
ceiling. It performed no edits, tests, network actions, services, or artifacts.

Hermes found no P0/P1 issue and identified two P2s, both fixed before the final gates: the public
receipt parser now binds the registry entry's `keyId` to the receipt signer ID, and the migration
now states accurately that `effect_unknown` is unsigned rather than calling it a signed receipt.

## Remaining boundary

This qualifies only dormant `meri_record_turn` effect authority. Clarification, memory proposal,
artifact staging/publication and reconciliation, signer/verifier operation, caller ownership,
runtime registration, and deployment remain open. No production database, provider, Meri prompt,
browser, deployment, or live traffic was used.
