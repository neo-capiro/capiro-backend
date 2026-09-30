# Governance test provider isolation

Hosted foundation7823 memory-governance job109217518073 passed842 tests in100 suites but exited1: the learning-signal governance harness triggered real asynchronous embedding, which imported AWS credential code after Jest teardown. This is a unit-test setup failure, not a passing workflow or evidence of a failed governance assertion.

The harness now returns the exact existing projection content hash for the created title and proposed body, matching the already established immutable-version test fixture. The real embedder takes its unchanged matching-hash short circuit. No production provider/routing/embedding code, governance assertion or test selection changes.

The learning-signal and immutable-version suites pass28 tests across2 suites with actual exit0 and no late-import/provider warning. Evidence: `C:/dev/cap-meri-foundation-evidence/memory-governance-provider-isolation*`. Scoped Prettier/diff checks exit0; independent Hermes/Bedrock Kimi static review exits0 SCOPED PASS (`review-memory-fixture-provider-isolation*`). Full hosted memory-governance CI remains required; no release or live acceptance PASS is inferred.
