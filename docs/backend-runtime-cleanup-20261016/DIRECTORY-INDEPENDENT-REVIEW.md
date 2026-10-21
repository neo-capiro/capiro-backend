# Independent Directory extraction source review

Read-only review of the concurrent successor work against PR30 service blob `4bce0f9ccfe1fe5dbd383ca18b8fd5a602839754` at `7b6bda7ca75ea86afb36c76f013f550fdd79e42f`. No tests, native TypeScript stripping, compiler, application, framework, build or child helper execution. Only this evidence file was written.

No concrete code blocker found in:

- `apps/api/src/directory/directory.service.ts` finite working diff;
- `apps/api/src/directory/directory-detail-mappers.ts` complete113-line source;
- `scripts/ci/directory-detail-mappers.contract.spec.mjs` complete192-line source;
- `docs/backend-runtime-cleanup-20261016/verify-directory-extraction-source.mjs` complete90-line source.

The service change adds one named helper import and replaces precisely seven algorithm bodies with raw forwarding calls. Each private signature and receiver-facing method remains. The moved helper bodies preserve the original expression order, optional chaining, nullish defaults, finite-ID conversions, strict boolean tests, array-object admission and preferred-name whitespace behavior. They do not use `this`; moving them to imported functions introduces no receiver dependency. The helper imports only the existing DTO types, using the repository's `.js` type-import convention. There is no new runtime/application dependency or service/module registration change.

The seven semantic tests check complete DTO outputs and nonmutation for actual coercion/falsy/nested/raw-input behavior. The eighth ownership case checks canonical import/export/signatures, exact raw forwarders, copied-algorithm refusal and runtime-import refusal, with an unrelated-service-edit admission control. The permanent tests no longer hash the entire143KB service, pin mapper algorithm hashes or pin the11callers. Future algorithm changes still require their own behavioral review; these tests are not a general sandbox or a substitute for API typing/native qualification.

The separate docs CLI keeps the exact extraction snapshot: seven original algorithm identities, restoration of the original service hash,11unchanged callers and a counterexample that an unrelated edit fails this snapshot. It performs source reads only after explicit `--run`, labels its output `one-time-source-extraction-proof`, and explicitly states it must not become current CI. Keep this CLI/report as source evidence rather than importing it into permanent tests or the current catalog.

Remaining qualification limit: this review did not run the eight controls, one-time proof, native API parsing, Jest, TypeScript checking or build. Parent/shared queue owns execution and receipt capture. PR30's old retained-boundary snapshot must stay sealed; an explicit successor profile should account for this authorized production-source extraction.
