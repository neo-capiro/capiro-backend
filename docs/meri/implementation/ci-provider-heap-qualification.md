# Focused A provider contract heap qualification

The provider contract step now uses NODE_OPTIONS=--max-old-space-size=6144. At foundation commit 248d22de4fd4da7ab0c84ddc0ccf8d69643fe192, hosted job 109204555741 generated the canonical Prisma client successfully, then exhausted the default JavaScript heap. This focused backport changes only the existing Provider contract step's environment; the workflow is byte-identical to the independently reviewed foundation repair in 0e23f8873a84a60b7a1627566088b858aac7104c.

Strict YAML comparison preserves every other setting and step. The exact verifier previously passed 19 tests in two suites with exit 0 on focused A at b5e81e58e0f1fd3b42f046e2ec33c9164dab6f61. The same verifier, with the new heap setting, passed 19 tests in two suites with exit 0 on foundation. Its source is identical in both branches; no repeat test run was needed for this workflow-only backport. Hermes/Kimi independently reviewed the exact heap change with exit 0 and scoped PASS.

The foundation catalog-test repair is excluded. Focused A retains its smaller tool registry and the corresponding 76 read-tool / 132 total-tool expectations. Its registry does not contain the four additional foundation tools, so copying the foundation's 80 / 136 assertions would misrepresent this branch's scope. No catalog implementation or test changed.

Evidence: C:/dev/cap-meri-foundation-evidence/outreach-provider-heap-review-ready-qualification.json, review-capture-fence-and-ci-heap-report.md, and remaining-acceptance-20260929/outreach-focused-provider-contract-exit.json.

Fresh hosted CI remains required. Other failed gates and live acceptance remain open. This change includes no GitHub main merge, deployment, database, routing, or model-policy change.
