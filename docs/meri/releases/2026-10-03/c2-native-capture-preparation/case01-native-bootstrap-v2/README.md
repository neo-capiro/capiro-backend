# Case 01 native bootstrap v2 — prepared, not executed

This preserves the reviewed v1 native composition and fixes its two P2 findings.
The v1 source, checkpoint, review, and evidence remain unchanged. See the v1 README
for canonical scope, original prompt, budget, one-owner settlement, authentication,
storage, and failure handling. No fixture, native owner, production source, rates,
model, configuration, or acceptance standard changes here.

## Exact release requirement

`case01-prepared-guards.mjs` performs a pure equality check against the qualified
API `5b086a6b` / `d20110a1…` and orchestrator `fb17c7eb` / `2b3ac021…`, including each
exact CodeBuild ID and buildspec hash. `buildCase01Scope` calls it before setup
receipt access, journal adoption, reservation, authentication, or conversation
creation. An older valid ancestor cannot satisfy this expectation. Existing live
AWS build/served checks and native admission are still required and grant actual
authority; the pure helper and filled template do not grant it.

The template fills only these now-qualified build expectations. The actual setup
receipt, its hash, private manifest hash, clean operator commit and served web
source still need a new reviewed scope after setup succeeds.

## Truthful uncertain execution

Immediately before entering `executeCase01LiveCapture`, the operator records an
execution intent and fsyncs both its append-only event history and current summary.
After that intent, a missing/invalid returned submission count is recorded as
`turnsSent: null` / `UNKNOWN_AFTER_EXECUTION_INTENT`, including final console output.
An actual native count remains authoritative. Zero is emitted before an attempt
or when the native outcome explicitly observes zero. No automatic retry, refund,
second settlement, or reservation release is added.

## Validation and remaining work

The tests import only the pure guard module and built-in Node modules. They cover
the exact pair, old orchestrator, changed immutable build fields, shape changes,
and known/unknown submission outcomes. Syntax checks and byte-for-byte offline
reproduction cover the complete generated operator. These checks do not import or
execute the operator, authenticate, call an owner, open a journal, create a
conversation, or call any provider. Independent review and actual authorized
release/setup/capture remain separate. Full File 01 acceptance stays NOT_RUN and
requires human adjudication after real evidence exists.

Use v2 explicitly after its review. Both versions retain the same exclusive run
ID/output claim, so they cannot be used to launch duplicate runs. Never run v1.
