# Phase 4 broker-policy subset contract

This is a default-off source contract. The current adapter calls `buildEnvelope`
without a tool view and retains the six-tool legacy policy. No application
path calls `createRunWithToolView` or supplies a view to `buildEnvelope`.

For a future authenticated, compiled `MeriHermesToolViewV1`,
`brokerPolicySubsetForToolView` maps each of the five registered Meri worker
tool names to the same-named broker operation. A selected Hermes native tool
does not grant broker access. A selected unknown `meri_` name fails closed.
The mapping is exhaustive against `MERI_HERMES_BROKER_TOOLS`, so adding a broker
name requires classifying it before type checking can pass. This contract does
not assert completeness or version parity with Hermes' entire native catalog.

`meri_record_turn` is a broker `POST /turns` endpoint, but neither local Meri
plugin registers a model-visible worker schema for it. It is absent from the
derived allow-list. A view that selects that name fails closed. A future
run-local exception would require separate justification, an authenticated
representation in the selected view, and a reviewed worker schema. This
contract supplies no exception mechanism.

The source-only adversarial specs cover each known mapping, empty and native
views, unknown Meri names, and forged views.
They have not been executed in this resource-constrained handoff. Before
activation, the caller must establish worker/API catalog-version agreement,
current authorization and availability, required dependencies, and the
authenticated worker view for the same run. The pinned worker's signed-view
prototype and image harness are separate acceptance work.
