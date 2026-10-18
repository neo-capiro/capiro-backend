# Core A8 action read receiving outline — 18 October 2026

Base: integrated Core source candidate `869ee0eb461d15af75ccf83186e6b897d7529bc1`.
Meri sources: PR166 `15288a7954862e348af86bf1eab119fdb30863a0` and PR167
`2c53e6c5123d392308d84a74eb8da2e5741f5dc1` (heads checked by
`git ls-remote`). This is source preparation, not an installed read.

## Bounded implementation

1. Keep the original `actions.query@0.2.0` operation in Meri's ADMITTED
   allocation and UNKNOWN reservation. Keep its original arguments SHA-256.
2. Permit a Core Option B `tool` token for that **same operation** only at its
   exact `/api/clio/tools/actions.query` path and exact emitted JSON body hash.
   The existing issuance/use transaction, signed token, selected client,
   membership, consent, and final release checks remain mandatory.
3. Route only a verified delegated request on that path to Core's existing
   `query_action_items` read owner. Require the selected canonical client UUID
   and the client-scoped body shape; no ordinary bearer or model tool exposure.
   The source switch `MERI_ACTION_QUERY_ALIAS_ENABLED` defaults to false and is
   not set in the preview template. The issuer also returns 503 before minting
   a one-use token while that switch is off, and refuses any operation version
   other than `0.2.0` before a token is created. The canonical owner remains
   subject to its existing `query_action_items` preview tool allowlist entry.
4. Meri must change its source adapter to build and freeze the outgoing body
   before requesting the post-reservation token. The existing adapter uses a
   user Bearer and obtains credentials before forming the body, so it cannot
   consume this source path yet. Output remains the canonical
   `query_action_items` result and its current owner proof.

The A8 source also leaves legal citation observations and Outreach unscoped
scope held. Core can narrow Outreach exact-record reads only after the current
root and nested client/meeting/prep/debrief walls are proved; no arbitrary
unscoped tenant campaign list is authorized by this outline. Four separate
news facts remain in Meri PR166's handoff.

Verification: focused alias admission, ordinary-bearer refusal, original
UNKNOWN reservation, exact request-byte hash and one-use replay tests.
Deployment, Meri adapter receiving, credential relay, image/config
identity and live readback remain separate gates. No live SQL, grant, key,
provider, AWS or paid build is part of this branch.
