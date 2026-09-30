# Knowledge Plane workspace build qualification

Knowledge Plane CI at foundation `248d22de4fd4da7ab0c84ddc0ccf8d69643fe192` failed API type-checking because the clean runner had no built declarations for its four declared workspace dependencies. Actual job `109204556449` reported missing shared, Meri core, defense-contracts and defense-domain modules.

The workflow now builds those four packages before the existing API type-check, with shared first to satisfy dependent package imports. Strict unique-key YAML comparison confirms this is the only workflow change; existing schema, migration, database, type and test checks remain intact.

On foundation `8a4c88c815d19219c0030cf18b1636357c075c28`, all four package builds, API type-check and the existing complete Knowledge Plane Jest gate exit 0. Jest collected 331 passing tests in 59 suites with its unchanged default heap. Independent Hermes/Kimi review on Bedrock completed exit 0 with scoped PASS.

Evidence is retained in `C:\dev\cap-meri-foundation-evidence\knowledge-plane-dependency-repair` and `review-knowledge-plane-dependencies-report.md`. Initial validation-tool module lookup failures are recorded separately; the successful YAML check uses the already installed yaml package, without installation.

No production behavior, database, model policy, routing or deployment changes are included. Fresh hosted CI and other release gates remain required.
