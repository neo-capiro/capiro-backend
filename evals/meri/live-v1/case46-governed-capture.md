# Original case 46: governed export prerequisite

The API proposal/effect boundary is implemented, but the full live case is not enabled: fixed setup and chat/V3 forwarding remain incomplete. This checkpoint adds no route, seeds no output artifact, and does not turn the read-only capture capability into write authority. Original case 46 and the original 75-case plan remain incomplete.

The fixed original prompt is `Export that briefing and give me the file.` The expected output remains `aster-synthetic-briefing.txt`, exactly 28 UTF-8 bytes (`Synthetic Aster briefing v1` followed by LF), SHA-256 `c26beebc62f179a568981d811784dc75ad7e2cad79c94165d6f4859dcb278c53`.

## Current source contracts

- `packages/meriv2-core/src/context/governed-artifact-capture.ts` defines a separate MAC-authenticated capability for this case only: the approved T1/Pat/Aster identities, one `create_word` proposal and artifact, canonical current-user approval, exact text input, no dynamic MCP, suppressed incidental writers, and a maximum 15-minute validity. Its transport cannot be decoded as read-only capture authority. The API proposal and artifact insert owners enforce these ceilings; the current chat/V3 path carries this separate authority.
- `apps/api/src/meri/meri-case46-authority.ts` reads the actual current ordinary actor, Clerk identity, active membership, client wall, owned conversation, canonical input document row and current storage hash. The source identity matches the existing client-document writer and fixture ownership algorithm. The input is an Engagement attachment, separate from the clio artifact the export must create. It must be ready under the canonical attachment owner; no scan/lifecycle override is provided.
- `installCase46CaptureBinding(deps, args)` is an internal operator function, with no HTTP endpoint. It locks and requires an empty owned conversation and an exact prior metadata hash, re-reads current source authority, and atomically installs a sealed binding while retaining unrelated metadata. The externally qualified rate sheet must match the current verification hash. The actual service secret is required through the existing process environment; no default or guessed key is supplied. It creates no message, proposal or output artifact.
- `apps/api/src/meri/meri-case46-provider-budget.ts` uses the existing research reservation arithmetic in its own `governedArtifactProviderBudget` metadata field. A policy binds the full qualification hash, current source verification and rate expiry. Unknown prices or output bounds fail closed; reservation replay does not grant another dispatch; uncertain usage retains its charge and cannot yield a successful usage receipt.
- `apps/api/src/meri/meri-case46-provider-budget-owner.ts` holds current source/actor/conversation locks while changing that ledger. It verifies the installed service MAC and actual single persisted original user prompt. Concurrent API processes serialize on the real conversation row. Final usage evidence requires at least one known settled attempt and no reserved or uncertain attempt.

`issueCurrentCase46Policy` returns null when the owned conversation has no sealed case 46 binding. The existing action-proposal and artifact-write paths consult the separate authority when an owned case46 binding exists. Ordinary unbound policy decisions and the read-only capability are retained. Sealed bindings cannot be refreshed or reset by these functions, and ambiguous operations must not be automatically retried.

## Evidence limits

The core and API unit tests exercise MAC separation, expiry, scope/input tampering, qualified pricing, bounded reservation, retry, settlement and receipt refusals. The PostgreSQL test executes the production owner functions against an explicitly verified owned loopback server on port 55433, with a disposable schema. It observes a second backend blocked on the actual conversation lock, checks rollback after an injected write failure, and rejects changed source bytes, client-wall removal and source-row version changes. The canonical storage port in that test is a bounded fake. This proves the local transaction and source-read contracts, **not live S3, the production database role/RLS, a model turn, approval, or a download**.

The existing `case46-artifact-ui.mjs` is a separately reviewed approval/download substep. It compares actual response and browser-downloaded bytes, current canonical proposal/effect receipt, and the same artifact after reload. Its result remains `UI_SUBSTEP_ONLY`, not full live acceptance.

## Required continuation before any live case 46

1. Compose a fixed operator using the real ClientDocumentWriter/Engagement owner to create only the namespaced input briefing and an empty owned conversation. Read current source bytes and install the qualified sealed binding. Preserve exact source/recipe/operation receipts and stop on an ambiguous write; never prepopulate a successful generated clio artifact or assistant response.
2. Qualify the implemented separate current-turn/provider transport on the final integrated images. It requires the existing V3 route and refuses an unaccounted legacy fallback. Case46 remains outside every read-only capture union.
3. Complete the authenticated capture readback joining the real proposal, operation, output artifact and settled usage. Canonical creation/approval/insert guards and chat/V3 forwarding are implemented below; they still need full live qualification.
4. Have the fixed native capture operator send the original prompt once, consume the actual admitted proposal, and run the reviewed UI substep. Persist only sanitized authority/usage/effect/download evidence. Require the qualified API, orchestrator and Web releases and fresh root readiness. A new text MIME path still needs the matching deployed Web and actual Playwright verification.
5. Run the deterministic Meri evaluation on the final integrated source, then the authorized live case. Any pending source, provider, approval, byte, scope or durable-receipt condition keeps case 46 blocked. Do not count this checkpoint toward the live 75-case pass total.
## Canonical proposal/effect checkpoint

The API now admits the separate signed case46 action-proposal transport behind
the existing authenticated internal route. The current source owner validates
the actual actor, client wall, frozen source bytes, original user turn, sealed
binding and provider ledger inside the proposal transaction. It permits one
proposal. The normal policy decision is retained; even a `PASS` decision waits
for explicit browser approval. `BLOCK` remains blocked.

Approval rechecks current authority and fully settled usage before the normal
execution claim. The actual artifact insert transaction repeats that authority
check, joins the currently executing proposal approved by this actor, validates
the exact output bytes and operation identity, and refuses any existing artifact
in this owned conversation. An authorized retry after a pre-write failure is
not confused with a second effect. The private capture marker is omitted from
the public preview.

Validation: 161 targeted Jest tests passed with one existing optional PostgreSQL
test skipped; a subsequent 13-test HTTP run includes the new real DTO/guard
case46 transport assertion. The dedicated owned PostgreSQL suite passed both
tests, including a second actual backend blocking on the conversation lock,
rollback, missing approval, changed source/output and duplicate-effect refusal.
The storage read port is mocked in this suite; it does not prove live S3/RLS.
Primary API typecheck passed. Independent Kimi source review completed with
PASS/exit0; its raw speculative analysis is not test evidence.

Fixed setup and the composed original-prompt/download operator still require
integration and qualification. Original row46 and the
75-case live matrix remain **NOT RUN**, not passed by these tests.

## Governed turn and provider transport checkpoint

The actual Context Plane runtime now re-reads the sealed source owner before
retrieval, admits a separately priced budget, and binds the one actual persisted
user-message ID. The user-message insert repeats the current owner checks and
empty-conversation requirement while holding the same conversation row lock.
The verified input briefing is added as source data; no output is prepopulated.

The existing V3 transport authenticates the separate policy under the governed
context MAC. The controller requires the exact original prompt, selected client,
one message, no image/page-write/research overlay, and a bound turn. The assistant
exposes only `create_word`, revalidates its exact input at dispatch, and routes it
through the canonical proposal owner. Direct tools and dynamic MCP are denied.
The actual schema's optional empty `sections` array is accepted for txt; nonempty
sections, alternate bytes/format/name and other tool inputs remain denied.

API retrieval and V3 model attempts use the existing reservation arithmetic
through a separate current authority and ledger. The provider ingress rejects
mixed MAC audiences. Failed/uncertain settlements cannot produce a saved successful
usage receipt or approve the export. A saved assistant message receives the
server-owned settled receipt, and incidental maintenance/audit/shadow writers are
suppressed for this exact capability. Ordinary turns retain their existing flow.

Local validation: API78 tests, orchestrator bridge36, assistant116, and core9
passed. The final five-test wiring run includes four of those API tests plus an
explicit dual-scope refusal. Actual owned PostgreSQL3/3 checks include two
concurrent turn inserts, provider reservation contention, rollback and canonical
effect guards. Primary API and orchestrator typechecks passed. Test doubles do
not establish live storage, provider usage, production RLS, browser or acceptance.

Independent Kimi source review ran with exit0 and returned BLOCK findings. Its
specific premises conflict with the actual source (existing parent row lock,
lowercase headers, correct `format` schema, and existing nullable ordinary-scope
contract); the raw review and factual adjudication are retained in task evidence
for independent integration-owner review. Do not represent that review as PASS.

## Fixed setup operator

The image now has `meri-case46-setup plan` and `meri-case46-setup execute` verbs.
The entrypoint composes the existing database URL and runs only the fixed operator.
`MERI_CASE46_SETUP_INPUT` is a maximum6000-byte JSON envelope with `recipe` and,
for execute, `expectedPlanSha256`. The strict recipe fixes case46, namespace,
ordinary Pat and Aster; it supplies a fresh capture-run UUID, current Clerk identity,
and independently reviewed provider rate evidence/expiry and integer limits.
The operator does not obtain credentials or modify provider configuration.

Plan verifies current actor, wall, namespace and absent source/conversation/claim.
Execute repeats those reads under the tenant row lock and compares the actual
plan hash. A durable exclusive claim precedes source storage or conversation
creation. Unrelated tenant settings remain intact. An error preserves the claim
and emits the stage and bounded error codes; there is no automatic retry/reset.

The minimal runtime uses the real PrismaService, canonical Engagement document
writer/reader, attachment scanner/content services and configured ClientKb index.
Unrelated Engagement collaborators refuse access; no AppModule or background
worker starts. An internal exact-input scope awaits the actual source index when
enabled, so its metadata update finishes before the current source version is
sealed. Ordinary document creation still indexes in the background. Disabled
indexing stays disabled and required-but-unavailable scanning remains blocked.

Only the INPUT briefing is created. The actual product method creates an empty
owned conversation; a fresh current-source read then installs the sealed binding
and qualification. No message, proposal, generated artifact or success is seeded.
The binding expires15minutes after installation: prepare the browser operation
before executing setup. A completed/failed claim cannot be silently reused.

Validation:18 targeted canonical document/index/factory tests,6 fixed-CLI tests,
and5 owned PostgreSQL tests passed, with zero skips; primary API typecheck passed.
The PostgreSQL positive setup uses the actual PrismaService tenant/transaction
methods and a TenantRole enum, real document/conversation services and binding
install. S3 is an in-memory test transport and indexing is explicitly disabled
in that test. Separate tests exercise awaited-index failure propagation and
current-actor checks. This does not qualify production RLS, live storage or a model.
Independent Hermes/Bedrock Kimi source review completed PASS with process exit0;
source review is separate from the actual test receipts.

Full authenticated original-prompt/proposal/current-effect capture composition,
qualified API/orchestrator/Web deployment and actual browser download remain
required. Original row46 and the75-case live matrix remain **NOT RUN**.
