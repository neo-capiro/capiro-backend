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
