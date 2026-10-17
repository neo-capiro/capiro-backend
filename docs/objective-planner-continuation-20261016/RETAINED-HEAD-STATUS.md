# Immediate current-consent status with a retained Planner head

This bounded source successor starts from native-qualified PR50 commit
`5591eac08428635bf911a0aa32acea859e2a5d95`. The qualified source, native receipts
and shipping pins remain separate. Final successor test results belong to its
exact published commit and are recorded in its PR and task evidence.

## Behavior

After a new explicit Planner consent targets an advanced ready Objective, the
older canonical project and tasks can legitimately remain while the new work has
not started. The early Core status-read path may now return the existing
`not_started` label for that current consent. It does not report the older
applied operation as the new operation.

The new observation is read-only. A separate read-gate marker and a private
policy-ineligible accounting marker prevent it from becoming retry permission.
Command-gate reconciliation, the closed advanced-source regeneration witness,
the command kernel, source/control CAS, exact replay and original deadlines are
unchanged. A new retry in this transient state still refuses. The independent
server worker may consume its own eligible durable saved generation under the
existing runtime authority; status reads neither dispatch it nor supply a grant.

## Required evidence

The current consent must target exactly the current ready Objective source in
all ten source fields. A dedicated native verifier reads its actual consent,
reciprocal issuance command, root intent and ready revision. It checks complete
captured/native equality, actor/membership/Clerk identity, source hash, policy,
original duration and timestamp consistency. It constructs no operation for work
which has not started. The current reader may differ from the consenting actor;
the unchanged WorkService supplies current human, membership and wall authority.

The exact plan-wide application head selects the older applied anchor. Its full
v2/v3 ancestry must consume every inventoried application and materialization
row and pair every applied operation with its exact native consent lineage.
Bindings, source versions and controls precede the new consent. Every old
terminal precedes or equals its confirmation; adjacent applied predecessors
also have strictly increasing controls and nondecreasing terminal times.
Historical failed/cancelled bridges retain their existing native proof and exact
receipt-accounting checks. The current consent must directly name the selected
anchor consent as its previous consent.

Under the same Planner gate, no current operation or current-binding effect may
exist. Exact current application and owner receipt IDs use the current canonical
source, current consenting actor and original issuance Clerk. Tenant-and-ID
probes do not filter kind, embedded scope or owner, so renamed or concealed
receipts cannot prove absence. The older plan-wide head is expected to exist and
must be verified, rather than treated as a missing current head.

A bounded live-and-archived output inventory must match the known project/task
identities from the complete checked ancestry, including v3 retained task
identities. Edits to known output values remain intact. Missing, extra, orphan or
overflowing output identities remain uncertain. No immutable ledger gains UPDATE
or DELETE privileges; native proof queries lock only mutable identity rows.

## Deliberate limits

- This slice covers the immediate new consent with no current operation. Current
  queued, leased, failed or cancelled work beside an older head retains its prior
  conservative behavior.
- Intervening consents without an operation need a separately specified complete
  native consent-chain proof. A greater control number alone is insufficient.
- Human-created additional task identities are indistinguishable from unexplained
  output without additional provenance. Allowing them requires an explicit output
  ownership rule; this slice keeps their status uncertain.
- Original consent expiry may have passed during a retained read. Original
  consistency is checked and the existing expired flag remains honest; the
  current request proof must still be valid.
- No real issuer, SDK/provider, HTTP/JWT/session or browser activation is added.
  Ordinary chat and first-chat shipping remain independent. Execution remains
  disabled by default, and no deployment, migration or shared binding is changed.

The focused source checks cover real helper/kernel code with synthetic SQL ports.
The prepared native regression reads immediately after actual new consent,
preserves a human edit to an existing output, verifies unchanged write refusal,
then lets a separate runtime consume a durable accepted generation and verifies
its v3 result through Core. A further actual Objective/consent advance checks the
transient read over that complete older v3 ancestry. Its enabled result is not
assumed from source-only checks or from the qualified parent run.
