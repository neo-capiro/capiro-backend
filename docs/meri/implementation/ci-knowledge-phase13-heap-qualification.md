# Knowledge Phase 13 test heap qualification

Hosted run 36506930467, job 109210328154, on focused commit f292e02572e13a441d59dfbadf0b1e96d5be1b43 successfully built workspace packages and validated/generated the canonical Prisma client. The Phase 13 provider and boundary tests then failed with JavaScript heap exhaustion around 2042 MB. Later workflow steps were skipped.

Only that failing test step now receives NODE_OPTIONS=--max-old-space-size=6144. Strict unique-key YAML parsing and semantic comparison confirm every other workflow setting, command, gate, environment value and step is preserved. The exact five named suites passed 19 tests with actual child exit 0 using the new heap setting. Formatting and diff checks also exit 0. Separate Hermes/Kimi review on Bedrock returned SCOPED PASS with exit 0.

The bounded Hermes/Qwen proposal expressed the correct two-line insertion but supplied malformed diff metadata. Codex mechanically applied the exact insertion under the existing implementation exception. The configured C:/Users/neoma/bin wrapper was absent on this host; the first invocation launched no test child and is explicitly recorded NOT RUN. The successful run used installed Corepack pnpm with the same arguments. Setup failure and successful test evidence are separate.

Evidence: C:/dev/cap-meri-foundation-evidence/focused-knowledge-phase13-current-run.json, focused-knowledge-phase13-current-job.log, focused-knowledge-phase13-tests-exit.json, focused-knowledge-phase13-semantic-validation.json, focused-knowledge-phase13-review-ready-qualification.json, and review-focused-knowledge-phase13-heap-report.md.

These controlled checks do not establish fresh hosted CI success or full Workstream A/File01 completion. Other failed gates remain open. No database, routing, production model policy, GitHub main merge or deployment is included.
