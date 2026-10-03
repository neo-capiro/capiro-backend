# Case17 configured CLI identity repair

The first current-image proposal UI attempt stopped before sign-in because the existing collector accepted only `hermes-cli`; native STS identified the configured CLI as `capirocli` in the same account. This eval-only change admits those two exact IAM user ARNs and records the observed caller. All immutable build, current service, source, fixture, browser and read-only checks remain in place.

The same caller tests failed for `capirocli` before the repair (6 pass, 1 fail), then passed together with the existing build/forged-authority guards (7/7). Independent review passed. The final test file has only Prettier formatting changes and passed 7/7 again. [Review](independent-review.json), [retained failed attempt](case17-regression-result.json), [native current-build preflight](case17-native-build-preflight.json).

The corrected native preflight verifies API517/source `f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f` and unchanged WebVNext388/source `78ad5805679a3045b1fc10fb19beafa7f76e4e64`. This collector change requires no service deployment. The failed attempt created no Clerk session, made no provider call and made no application write. It does not establish browser success, the original case17 prompt, human grading or full acceptance. The original six-proposal fixture is retained for a separate new capture attempt; no seed/reset/reapproval is authorized by this repair.

All archived bytes are listed in [artifacts.json](artifacts.json). Existing clock implementation files and the separate PostgreSQL storage test are excluded from this change.
