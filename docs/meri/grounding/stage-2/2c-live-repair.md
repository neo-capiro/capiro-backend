# Stage 2c: live bounded repair

Stage 2c connects the replay-tested repair loop to MeriV3 chat immediately after normal finalization and before the one text emission. It is independently controlled by `MERI_AUTO_CORRECTION_MODE`, tenant and surface enrollment, and the human-set `MERI_AUTO_CORRECTION_CATEGORIES` allowlist. Repository and release defaults are dark; an empty category list promotes nothing.

## Policy and boundaries

Only material claims whose category is promoted are assessed or revised. Deterministic exact-value and freshness checks run first. Jev then assesses eligible claims; provider failure, confidence below 0.5, compound claims, and a deterministic ten-percent sample of high-confidence approvals cascade through the existing request-scoped legacy judge. Other categories remain byte-identical.

A repair receives at most one pass, three read-only tool calls, 8 seconds, and 60,000 input tokens. The executor requires both registry `readOnly: true` and execution metadata `executionMode: read`, refuses unknown tools and schemas whose required arguments cannot be projected from governed turn identities, and deduplicates failed calls. New results use the normal evidence projection and stable citation numbering. The revision model sees only affected/dependent sentences and the affected claim's listed passages. Form A marker validation and Form B citation checks run again before release.

Generic schema projection can deterministically fill PE code (`peCode`), award identity (`piid` or `contractorName`), client document identity (`documentId`), opportunity identity (`opportunityId`), and committee/bill identity (`committeeId` or `billId`) only when those values already exist in the governed turn context. Tenant, client, conversation, and literal request/query fields are also projected when the schema declares them. A required value absent from that context is never inferred: execution refuses with `no_concrete_route`.

`shadow` performs the same assessment using an empty replay executor and an identity generator: it logs proposed outcomes but emits the original reply and never retrieves. `enforce` may retrieve and revise. Budget or source failure remains claim-local; unrelated supported content is never held. Structured events are `meri.auto_correction.claim` and `meri.auto_correction.turn`.

## Replay proof

The focused `live-repair.service.spec.ts` fixture runs the Stage 1 repair interface with fake providers, executor, and generator.

### Automatic status correction

Before:

> TITAN is not in production. Unrelated content remains.

After a read-only status refresh returns `TITAN entered production.`:

> TITAN entered production. Unrelated content remains.

The exact unrelated sentence is retained and the trace uses one pass within the three-call ceiling.

### Useful partial completion when the transcript is unavailable

Before:

> The transcript says the chair promised action. The bill passed the House.

After the document route reports the transcript unavailable:

> Evidence limitation for “The transcript says the chair promised action.”: the named transcript is unavailable. The bill passed the House.

The document claim is narrowed locally; the independent supported bill sentence remains. A UI dialog or whole-answer refusal is never introduced. When an explicit document filename is available to the application adapter, the claim-local limitation may instead be the single specific request: `To confirm the chair's statement, attach the <name> transcript.`

## Validation

Focused specs cover category exclusion, correction, deterministic sampling, fail-closed read-only execution, unfillable arguments, evidence registration, remaining-budget timeout forwarding, and abort racing. Core and orchestrator typechecks and the release-script verifier are the acceptance gates.
