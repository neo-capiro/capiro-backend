# Standalone UI shared-contract prerequisite

Current hosted b40d25e70 jobs109237089972 and109237090166 pass the previous Node and generated-comment checks, then fail web typecheck with TS2307 for @capiro/shared. Both standalone UI verifiers omitted its build, while the package's declarations are exported from dist. Earlier local successful runs inherited built shared output.

Both verifier entrypoints now build @capiro/shared through their existing fail-fast command runner before web tests/typechecking. No dependency, application, assertion, route, test selection or compiler setting changes. Complete code and final verifiers pass again with the prerequisite in place: 142 and164 tests respectively, typechecks, production builds and whitespace checks, actual exit0. These local results do not imply hosted acceptance.

Independent Hermes/Bedrock Kimi static review returns SCOPED PASS, actual exit0. Evidence: C:/dev/cap-meri-foundation-evidence/ui-shared-prerequisite-*, review-ui-shared-prerequisite*, ci-b40-109237089972.log and ci-b40-109237090166.log.
