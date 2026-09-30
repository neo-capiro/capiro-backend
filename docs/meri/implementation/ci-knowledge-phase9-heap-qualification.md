# Knowledge Phase 9 retrieval test heap qualification

Hosted run 36507573019, job 109212356817, at focused commit 97e54c55a2e5c47ad1fb469b752fdf1256a60044 passed package-build and Prisma prerequisites, then failed the Focused Phase 9 Retrieval V2 tests step with JavaScript heap exhaustion. Later steps were skipped.

Only the failing step now sets NODE_OPTIONS=--max-old-space-size=6144. Every existing workflow setting, environment value, command, permission and gate is preserved, as verified by strict unique-key YAML parsing and semantic comparison. The exact unchanged src/retrieval command passed 273 tests across 28 suites with actual child exit 0 under the new heap setting. Scoped formatting and diff checks pass.

A bounded Hermes/Qwen session supplied the exact step name, environment key and value as valid JSON, with exit 0. Codex applied that minimal insertion. Separate Hermes/Kimi review on Bedrock returned SCOPED PASS with exit 0; it identified no gate weakening and explicitly did not authorize merge or deployment.

Evidence: C:/dev/cap-meri-foundation-evidence/focused-phase9-failed-job.json, focused-release-ci-audit/job-109212356817.log, focused-phase9-heap-proposal-validated.json, focused-phase9-semantic-validation.json, focused-phase9-tests-exit.json, focused-phase9-tests.log, and review-focused-phase9-heap-report.md.

Fresh hosted success remains unverified. Later workflow steps and other failing checks remain open. This qualification does not establish full Workstream A/File01 completion, and includes no deployment, production model, routing or database change.

Foundation integration retains its existing `--max-old-space-size=6144 --experimental-vm-modules` setting. The focused branch lacked the heap setting; no foundation workflow option is removed or changed by this backport.
