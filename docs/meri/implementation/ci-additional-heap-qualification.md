# Additional bounded CI heap qualification

The completed foundation7823 GitHub checks exhausted Node's default heap in the Knowledge Plane tests (job109217519479), Phase13 retrieval/vector regressions (109217519031), and Outreach Phase2 state tests (109217521321). The fix sets6144MB only for those exact test steps. The script preserves inherited Node options and the conditional Engagement scope variable; no test selector, assertion, skip, production code or release gate changes.

Actual local qualification on foundation5f91 with this delta: Knowledge331 tests/59 suites, retrieval19 tests/4 suites, Outreach state81 tests/12 suites; every command exits0. Logs and exit receipts: `C:/dev/cap-meri-foundation-evidence/ci-additional-heap/`. Syntax/scoped formatting/diff checks exit0. Independent Hermes/Bedrock Kimi review exits0 with SCOPED PASS (`review-additional-ci-heaps.jsonl`). The review is static; its wording “merge ready” does not waive full hosted checks, and the Engagement scope variable remains conditional, not unconditional.

Verdict: PASS for these exact commands and the scoped resource fix. Full hosted workflows remain NOT RUN at this candidate. This change performs no shared database mutation, AWS deployment, model/routing change or acceptance canary.
