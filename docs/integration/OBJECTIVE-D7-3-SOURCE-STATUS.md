# Objective D7-3 source status — 2026-10-18

State: **admit echo implemented in source; D29 open; no Objective relay or live authority enabled.**
This note covers only `apps/api/src/auth/workload-authority/objective-admit-credential-echo.ts`
and its focused spec. Meri's reference is `apps/control/objective-generation/core-http.mjs`
at `meri-greenfield` `8e7bf0e8` (also present at the earlier `09781127` owner pin).

## Implemented boundary

- `objectiveAdmitCredentialEcho` accepts a trusted Core admit issuance result, the
  exact Meri `readCredential` request, an independently resolved delegated actor,
  and a trusted check time. It returns Meri's closed 13-field echo for **admit only**.
  No Core route calls this helper today. Its `OBJECTIVE_ADMIT_ROUTE` constant is
  the Strategy target path, not a Meri-to-Core relay endpoint.
- It checks the issued token's decoded subject, audience, phase, operation,
  method, target path, body digest, tenant, job and expiry against the admit
  request. It recomputes Meri's `sourceSha256` from the complete Meri source and
  `requestSha256` from `{schemaVersion:1,generationJobId}`; those digests are
  distinct from Core's workload token `sourceSha256` (null for admit) and from
  Core's caller-proofed issuance-request digest.
- It refuses non-admit phases, changed target/request digests, a different
  delegated actor, expired or unsafe millisecond expiry, accessor or hidden
  input fields, and token claim mismatches. The helper **decodes but does not
  cryptographically reverify** the token: its `issued` argument must come from
  Core's trusted issuer after current native authority and durable JTI checks.
  The `delegatedActorId` argument must come from Core's delegation row, not
  from the Meri request.
- The focused spec uses an RS256 token signed with a process-local synthetic
  RSA 3072 key and checks the echo against Meri's `credential()` field/correlation
  rules. The spec is source evidence only; it is not a route or runtime test.

## D29 remains open

1. Define and authenticate the Meri-to-Core `readCredential` relay. Meri calls
   its injected port **twice per operation** and requires the same bearer on
   recheck. Its seven phases are admit, publish, accept, admission-read,
   request-read, complete and completion-read. Core's current caller-proofed
   decisions route instead takes `{schemaVersion,operationId,generationJobId,phase}`
   and returns `{token,authorizationJti,iatSeconds,expSeconds}` with HTTP 201;
   it does not return Meri's echo. A relay must resolve the native actor and
   current delegation on both calls, retain/revalidate the original JTI and
   token, and define the closed wire and error/status contract with Meri.
2. Core issues **admit only**. The other six phases need their own current
   native acceptance/run authority and issuer behavior. This helper cannot
   authorize them. Meri's response decoder and product composition remain
   unallocated in the referenced transport.
3. The production Objective admission runtime remains hard closed, and its
   delegation migration retains `CHECK(enabled=false)`. Activation needs the
   approved fence decision and migration, a policy revision, a Core RS256
   private issuer key from Secrets Manager, and Meri's RSA 3072-or-stronger
   caller-proof public key pinned in Core `callerKeys`. The present RS256 signer
   takes an in-process `KeyObject`; there is no KMS RS256 issuer path here.
   Runtime credential, key, database and caller readbacks are still required.

No route, key, security grant, migration or live service changed in this D7-3
source follow-up. D29 is a cross-repository integration and activation blocker,
not a test-only gap.

## Subsequent D29 source slice

`OBJECTIVE-D29-SEVEN-PHASE-RELAY-CONTRACT-20261018.md` now specifies the
seven Meri callback phases, a distinct bounded Core issue request, stable
effect operation IDs, a separate post-effect release proof and the required
original Meri run readback. Core source has the seven-phase echo correlation,
ten-field issue-request decoder, raw-body capture and named caller-proof
boundary. These are parsers and checks; no `/credentials` controller, later-
phase issuer, release authority or Meri owner composition is mounted.

## PR87 source audit (2026-10-18)

The current source does not support mounting the seven-phase echo safely. The
existing decision/issuance/proof-use/delivery tables already reserve all seven
generation-worker phases, with unique effect claims for `admit`, `publish`,
`accept` and `complete`; the missing part is a current-authority relay issuer
and its post-effect release transaction, not another unguarded HTTP route.

| Boundary | Source pin | Current limit |
| --- | --- | --- |
| Ten-field issue request and fixed seven-phase route/hash parser; raw-body and named RSA caller-proof check | `objective-credential-relay-{request,ingress}.ts` at `2e32a6baf5201b2ce4900cbf8bf03e35d9051fd0` | Source-only; does not consume the proof JTI, load authority or issue. |
| Closed 13-field seven-phase Meri echo | `objective-phase-credential-echo.ts` at `b40971b1f8de888687a8fb92fbdf4ff653fe10d3` | Correlates a trusted Core-issued token; does not verify its signature, resolve the actor, or establish current authority. |
| Later-phase native decision kernel | `objective-workload-later-current.ts` at `a42a1d61b510383f42029a9b6e142befb4f4b0d3` | Requires concrete tenant SQL/resource adapters and an authenticated original Meri ISSUED-run readback; neither is mounted. |
| Durable decision, issuance, delivery and proof-use schema | migration `20281016010000_client_objective_workload_delegations` at `6d24414da975b52ab9802a883b22c868ad14fc92` | The delegation still has `CHECK(enabled=false)`; schema alone grants no phase. |
| Production admission composition | `objective-workload-admission.module.ts` and `objective-workload-admission-runtime.ts` at `6c97e0f993ab47d5cc5c94b8021c985b0399ef8a` | Mounts only `/decisions`, calls `createObjectiveAdmissionRuntime()` without enabled bindings, and remains admit-only and closed. |

The required source order remains:

1. Meri passes one stable operation ID through both `readCredential` callbacks
   and defines a separate release call carrying the first token identity. An
   uncertain effect is reconciled by the matching read phase, without issuing
   another effect token. The proposed wire and phase matrix are in
   `OBJECTIVE-D29-SEVEN-PHASE-RELAY-CONTRACT-20261018.md`.
2. Core obtains an authenticated original Meri accepted-run readback and
   implements the tenant-scoped later-phase SQL/resource adapters in their
   declared lock order. It resolves the actor and current delegation from
   native custody, never from the request or Strategy echo.
3. Core composes the bounded issue parser and caller proof with the native
   phase decision and existing durable issuer ledger. In the same tenant
   transaction it consumes each proof JTI and preserves the unique effect
   claim; exact retries reproduce only the original live token. A distinct
   release path
   rechecks current authority and persisted effect state against that saved
   token without signing or allocating another JTI.
4. Both owners check seven-phase vectors and the issue-to-release races. Only
   then can the Objective delegation fence, policy revision, RSA caller pin,
   RS256 issuer key and runtime bindings be qualified for activation.

This audit did not mount an Objective route or change a credential, role,
database, signer, security grant or live service.
