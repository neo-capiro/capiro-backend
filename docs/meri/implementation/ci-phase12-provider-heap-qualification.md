# Phase12 provider contract CI capacity

Current hosted candidate b40d25e70, job109237089409, aborts the provider contract/storage step at approximately 2040 MB with a JavaScript heap-out-of-memory error. It does not execute the assertions successfully. The workflow now sets NODE_OPTIONS=--max-old-space-size=6144 only on that step. Its exact two-suite command, serial execution, assertions and failure behavior are unchanged.

The same two-suite command with the scoped heap passes 10 tests in two suites, actual exit 0. Workflow formatting and diff checks pass. Independent Hermes/Bedrock Kimi review is recorded in review-owner-heap-final-static*. The earlier follow-up returned only a plan despite exit 0 and is INVALID as review evidence.

Evidence: C:/dev/cap-meri-foundation-evidence/ci-b40-109237089409.log and phase12-provider-heap-qualified.log. This repairs test-runner capacity only; the fresh hosted result remains required and no product/embedding configuration changes.
