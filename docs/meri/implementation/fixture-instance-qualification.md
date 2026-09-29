# Fixture run identity qualification

Source: 92ecd07a877871ff9f311d84241e932910d588d9.

The original acceptance contract requires resetting relevant state before each case. The existing physical reset protocol accepts only unchanged seed rows; it is not a complete lifecycle for cases that approve, reject or otherwise change those rows. Deleting governance history to reuse one physical ID is not required by the original contract. This increment supplies distinct run identities while preserving the frozen logical fixture definitions. It does not implement retirement or qualify clean case state.

An optional lowercase UUIDv4 fixtureInstanceId is now bound into the manifest, each ownership marker, deterministic physical identities, candidate keys and document-writer idempotency keys. Logical IDs, payloads, frozen source/asset hashes, clients and authorized tenants are unchanged. Omitting the option preserves the exact previous manifest content address: 576d896c14953cfac9262b450a0b5c698aa850cd6acefb78e7c38aacdfb6eb8b for the recorded baseline configuration. Repeating the same instance is deterministic. Relabeling a manifest or mixing records from another instance fails validation even after recomputing the outer hash.

PASS, each actual exit 0:

- 33 native Node checks for identities, immutable content, original provisioning guards and document owner dispatch. Document dispatch uses a stubbed writer and qualifies forwarded identity/bytes, not real S3 delivery.
- Seven tests invoking the built SettingsAwareMemoryCandidateService and PrismaService against an owned local PostgreSQL schema. A new instance creates fresh pending candidates and leaves previous row contents, governance state and xmin unchanged. The schema is removed afterward. This does not qualify full migrations, RLS or shared-environment permissions.
- Scoped formatting and diff whitespace checks.
- Independent Hermes/Bedrock Kimi static review of the exact candidate, exit 0, SCOPED PASS. Prior untracked review artifacts were preserved and excluded.

Lead limits on review language: finite hashes do not guarantee zero collision probability, and content hashes are not authorization. The identity object is shallow-frozen, not a deeply immutable marker. Validation recomputes identities and checks collisions within each manifest. The static review did not independently execute the tests. A confirmation string is not LIVE authority; all existing trusted owner and capture gates remain required and unchanged.

Evidence under C:/dev/cap-meri-foundation-evidence: fixture-instance-baseline.json, fixture-instance-contract-final.log and exit receipt, fixture-instance-postgres.log and exit receipt, review-fixture-instance.jsonl and exit receipt. No application source, SQL migration, shared database, AWS, routing, feature flag or model policy changed.

## Required continuation

Fresh IDs are not tenant/query isolation: previous active records remain visible through ordinary product readers. Before claiming a clean case, retire relevant previous records through their canonical lifecycle owners and prove their exclusion from active reads. Preserve approvals, revisions and immutable audit history. For pending memory, use a guarded proposer withdrawal in the canonical transaction, with exact owned marker/content/version checks; never reintroduce the rejected adapter DELETE. Already-approved memory requires its canonical revocation owner, not withdrawal of its proposal.

Keep existing deletion/reset receipts literal. A future retirement receipt must identify the retained terminal state and old/new manifests explicitly; it cannot masquerade as physical absence or satisfy the current same-manifest reset chain. Qualify that new lifecycle and trusted capture binding before any LIVE run. Full File01, Workstream A and original served acceptance remain incomplete.
