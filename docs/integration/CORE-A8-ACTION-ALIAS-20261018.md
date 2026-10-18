# Core A8 action read receiving outline — 18 October 2026

Base: integrated Core source candidate `8ab53574a62b16155eec60aa01609ce7d8d50df3`,
which includes the first alias source `868aafea8a6d731a0cab4210c169a955359daecc`.
Meri sources: PR166 `15288a7954862e348af86bf1eab119fdb30863a0` and PR171
`eeeda2d415a976ea240de482e62f71a32020c9b7` (exact fetched head).
This is source preparation, not an installed read.

## Bounded implementation

1. Keep the original `actions.query@0.2.0` operation in Meri's ADMITTED
   allocation and UNKNOWN reservation. Keep its original arguments SHA-256.
2. Permit a Core Option B `tool` token for that **same operation** only at its
   exact `/api/clio/tools/actions.query` path, exact emitted JSON body hash and
   separately signed canonical correlation hash. The correlation-bearing set
   has the eleven prior retained reads plus `actions.query`; the eleven-source
   controller route set remains unchanged. Original `query_action_items` has
   neither this correlation claim nor a changed flat-body route.
   The existing issuance/use transaction, signed token, selected client,
   membership, consent, and final release checks remain mandatory.
3. Route only a verified delegated request on that path to Core's existing
   `query_action_items` read owner. Require the selected canonical client UUID
   and PR171's exact `{input,metadata:null}` body, where `input` is the
   normalized `client_scoped` selection. The original UNKNOWN reservation
   arguments SHA must equal the canonical SHA of the entire normalized input.
   The signed `{binding,subject,policyRevision,normalizationContext:null}`
   correlation must match the original ADMITTED binding, selected client and
   policy. Core projects only the validated selection to the owner's flat
   body. No ordinary bearer or model tool exposure.
   The source switch `MERI_ACTION_QUERY_ALIAS_ENABLED` defaults to false and is
   not set in the preview template. The issuer also returns 503 before minting
   a one-use token while that switch is off, and refuses any operation version
   other than `0.2.0` before a token is created. The canonical owner remains
   subject to its existing `query_action_items` preview tool allowlist entry.
4. Meri PR171 now builds and freezes the wrapper and correlation before its
   post-reservation one-use `CapiroMeriRead` token request. Its task-local
   relay and Core's source must still be measured together and installed with
   readback before this switch can be enabled. Output remains the canonical
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
