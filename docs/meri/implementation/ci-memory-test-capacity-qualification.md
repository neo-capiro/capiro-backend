# Governed memory test capacity

Current hosted Workstream A source `e1e94aa4f3b49bbcd212955738100891d38ac04e`, run `36480504883`, reached the API memory test step and exhausted its 4 GB Node heap (GC approximately 4038 MB), exiting 1. This supersedes the earlier typecheck-capacity failure. It does not establish a product assertion defect.

The only workflow change adds a step-local 6 GB Node heap setting to `Test API governed-memory Phases 1-16`. The complete test command, selected tests, serial execution, remaining steps and failure behavior are unchanged. The previous independently reviewed serial typecheck setting remains intact.

Hermes/Qwen implemented the two-line fragment; separate Hermes/Kimi static review passed. The lead verified the exact additive delta and existing Prettier check exit 0. Fresh hosted execution is NOT RUN at this checkpoint; capacity sufficiency and full suite success remain unproved. No gate was bypassed, and no main or deployment changed.

Artifacts under `C:/dev/cap-meri-foundation-evidence/`: `ci-a1-e1e94-memory-failed.log`, `memory-test-capacity-reviewed-delta.diff`, `review-ci-memory-test-capacity-report.md`. The implementation packet/report incorrectly described a default 2 GB limit; the real log and inherited workflow limit prove 4 GB, recorded here.
