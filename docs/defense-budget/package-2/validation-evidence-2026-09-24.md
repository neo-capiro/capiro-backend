# Package 2 validation evidence

## Local gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Jev core typecheck | PASS | `pnpm --filter @capiro/meriv2-core typecheck` completed with no errors after building the shared package. |
| Jev core build | PASS | `pnpm --filter @capiro/meriv2-core build` completed successfully. |
| Jev core suite | PASS | 100 suites passed; 1,180 tests passed and 2 pre-existing tests remained todo. |
| Consuming orchestrator build | PASS | Shared, auth, Jev core and strategy-verifier packages were built; the shared API Prisma client was generated; `pnpm --filter @capiro/meriv2-orchestrator build` passed. |
| Orchestrator Jev/canary regression | PASS | Provider factory, passage selector, shadow assessor and canary collector passed 53 tests after their intentional registry/envelope expectations were updated to v4 metadata. |
| Offline paired replay | PASS | Ten cases produced deterministic hash `b44905cc1820bd0c`; no provider endpoint or credential was used. |

## Acceptance mapping

| Package 0 fixture | Proof |
| --- | --- |
| Ambiguous alias | `program-ambiguous-aegis-alias` abstains with `insufficient_evidence`; task threshold is 0.99. |
| None outcome | `evidence-select-none` returns `none` and resolves to no candidate pointer. |
| Malformed response | Task provider maps malformed output to `malformed_response`; focused provider test and paired replay both cover it. |
| Provider timeout | Task provider maps timeout to `timeout`; focused provider test and paired replay both cover it. |
| Evidence envelope survival | Envelope tests preserve authority, provenance, completeness, relation scope, financial stage and dates through schema and Jev projection. Canonical SHA-256 identity changes with provenance or content, and the provider rejects question evidence that does not match the supplied envelope. |
| Task budget enforcement | Provider/client tests prove the registry deadline, input/output-token ceilings and HTTP-attempt ceiling are applied before any actionable outcome is returned. |

## Release limitations retained on purpose

- The Package 2 fixture labels are proposed, not independently adjudicated.
- No approved provider output-token price schedule exists, so USD estimates are `null`; token, latency and budget metrics remain complete.
- New tasks are shadow-only and absent from the deployed allowlist.
- No schema migration, canonical financial writer or automatic entity merge is introduced.
- No live paid Jev qualification was run; Package 0 sets the default paid-provider budget to zero until task qualification.
