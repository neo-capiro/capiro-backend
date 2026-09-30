# CI provider heap and Meri catalog qualification

At foundation `248d22de4fd4da7ab0c84ddc0ccf8d69643fe192`, hosted provider-contract job `109204555741` successfully generated the canonical Prisma client, then exhausted the default JavaScript heap. The repair adds `NODE_OPTIONS=--max-old-space-size=6144` only to the existing Provider contract step. Strict YAML comparison confirms every other workflow setting is preserved. The exact existing verifier passes 19 tests in two suites with exit 0 locally.

Hosted Meri canary job `109204556510` also exposed two outdated catalog assertions. The shared registry already declares `read_bill_text` and `read_monday_client_boards` read-only and full-chat-only. The test now expects both names and the resulting counts of 80 and 136. Exact name, description, uniqueness, manifest parity and read-only checks remain. Before: two failures and two passes, exit 1. After: four passes, exit 0.

Hermes/Kimi on Bedrock independently reviewed each exact change with exit 0 and scoped PASS. Formatting and diff checks pass. The initial Qwen heap proposal expressed the correct two-line change but supplied an invalid patch; Codex applied and verified the correction under the existing implementation exception.

Evidence: `C:\dev\cap-meri-foundation-evidence\outreach-provider-heap-review-ready-qualification.json`, `catalog-expectation-repair\qualification.json`, `review-catalog-expectations-exact-report.md`, and `review-capture-fence-and-ci-heap-report.md`.

These checks do not establish fresh hosted CI, live acceptance or deployment readiness. Other failed gates remain open. No database, routing, model policy or deployment change is included.
