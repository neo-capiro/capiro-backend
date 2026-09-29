# Pending memory candidate fixture qualification

The fixture command now calls the built application SettingsAwareMemoryCandidateService and PrismaService to create and inspect pending synthetic proposals. It uses the real positional API and canonical memory_candidate table; it does not substitute a fixture ledger for application state. The internal sixth identity argument requires explicit process opt-in, one of the two approved synthetic tenants, a deterministic namespace identity, and synthetic provenance. Active membership and client-memory access are checked in the insert transaction. Ordinary callers retain their existing proposal decision rules.

The runtime preflights both exact tenant identities and exposes only the memory_candidate owner. It avoids AppModule startup and rejects unused projection/provider/approval dependencies. Model-extraction proposals remain pending in client, firm and private scopes. Readback checks persisted content, provenance, governance state and row version; modified content or promoted state cannot produce a matching desired hash. Replacement and erasure remain unavailable until a governed lifecycle owner supplies the required guards. Document deletion also fails closed because its prior callback could not atomically fence ownership and row version. CLI runtime cleanup runs in finally; failed and unknown receipts produce exit 1.

## Qualification

- Shared, core, Defense contracts/domain and API builds, plus API typecheck: exit 0.
- Native Node fixture selection: 30 tests, zero skipped, exit 0. This includes six tests against actual built application classes and a local PostgreSQL database, 22 provisioning-boundary tests and two CLI failure/cleanup tests.
- Existing candidate atomicity, governance, approval, rules, settings-aware and auto-learning regressions: 56 tests across six suites, exit 0.
- Scoped formatting and diff checks: exit 0.
- Separate Hermes / Bedrock Kimi review: SCOPED PASS, process exit 0. Immutable source hashes are retained in memory-candidate-owner-review-manifest.json.

Evidence is under C:/dev/cap-meri-foundation-evidence: memory-candidate-owner-qualified-gates.json, memory-candidate-owner-final-node.log, memory-candidate-owner-regression.log and review-memory-candidate-owner-bounded-report.md. The first review exceeded its tool budget (exit 1) and is not accepted as successful; the bounded replacement exited 0. Earlier missing local builds and Jest file-URL module resolution failures remain recorded; native Node tests over built API classes supersede that loader setup.

## Limits and side effects

PostgreSQL qualification used a uniquely owned temporary schema on localhost:55433 with minimal canonical tables; the schema was removed afterwards. It does not prove full migration replay, Nest module assembly, shared-environment RLS, or served acceptance. No shared database, provider, tenant flag, routing or AWS deployment was changed. Other fixture owners and governed reset remain unfinished. This is a fixture increment, not full Workstream A or File01 completion.

The identity helper hashes canonical input with SHA256 and sets version bits to 5; this is an existing deterministic fixture convention, not a claim of standard SHA1 UUIDv5 generation. Review statements about transaction checks are scoped source observations, not proof against every concurrent revocation interleaving.
