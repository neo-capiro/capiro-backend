# Provider budget integration qualification

Verdict: PASS for the bounded API/orchestrator integration below. Full File 01 acceptance, combined durable coordinator/child execution, live acceptance, main integration and deployment remain NOT RUN.

Base: `d27945ed7080f56337361566fb084fadb5821008`. This combines the provider-budget donor `6329a2d472b605e0264329e94a578c6a683e17e9` with the foundation's current source-authority and narrative-repair implementation. Nineteen source/test files are covered by the final SHA256 manifest.

Reservations commit before owner/provider dispatch. Replay uses current canonical owner inputs, with tenant/client/conversation/lease and publication checks before admission and after awaits. Uncertain provider outcomes retain reserved usage; repeated identities do not authorize repeated dispatch. The runtime retains typed narrative repair and current procedure/capability authorization. Product provider routing is unchanged.

## Actual qualification

| Evidence | Result |
| --- | --- |
| Six API suites, including provider/tool budget unit and owned PostgreSQL suites, research service and durable replay | 77 tests, exit 0 |
| Seven runtime suites, including assistant, run budget, provider ingress, Responses client, request-scoped client and repair | 269 tests, exit 0 |
| Shared/core builds, API/runtime typechecks | Exit 0 |
| Independent runtime execution | 18 tests, exit 0 |
| Independent API semantic review | Scoped static PASS; no new API test execution claimed |
| Nineteen source/test file formatter check and conflict/debug marker inspection | Exit 0; no markers |

Evidence root: `C:/dev/cap-meri-foundation-evidence/`. Exact artifacts: `provider-combined-api-gates.json`, `provider-combined-api-tests.log`, `provider-runtime-final-lead-runtime-gates.json`, `provider-runtime-final-lead-runtime-tests.log`, `review-provider-api-integration-static-report.md`, `review-provider-runtime-integration-report.md`, `review-runtime18-provider-foundation-runtime-tests.log`, `provider-integration-final-gates.json`, and `provider-integration-final-source-manifest.json`.

The unique final runtime artifacts are authoritative for the 269-test count. An earlier review overwrote older lead log names with its separate 18-test run; those older files must not be cited as 269-test evidence. Review prose is scoped to inspected behavior; speculative broader readiness and unverifiable line references are not adopted.

## Integration repairs and side effects

The lead preserved and recovered the original provider patch after an implementation worker replaced the service with its base. The resolved union restores current owner inputs and unconditional final publication checks. Fixtures now carry exact reservation identities, canonical admitted capabilities and earlier post-await authorization refusals without dropping assertions or weakening production gates. Four files received only the existing Prettier transformation after the review manifest; all other reviewed hashes remain unchanged.

PostgreSQL tests used the dedicated local instance at `127.0.0.1:55433` and owned schemas. No shared environment, external connector, main branch or deployed service was changed. This report does not establish the remaining full-plan acceptance requirements.

## Current foundation integration

The exact provider candidate `d437df2bff616810dfa3e6e9161267f05afbdb7d` was integrated onto foundation `e945cad88ee95baf6022abae2be3e82491a5324c`. None of its twenty paths overlap the intervening foundation changes. The final combined branch passed 97 tests across seven API suites, including the current attachment helper regression suite, shared/core builds and API/runtime typechecks, all exit 0. Provider source hashes match the reviewed final manifest. Artifacts: `provider-final-foundation-gates.json` and `provider-final-foundation-api-tests.log`.

The hosted foundation release-matrix formatting failure identified seven additional existing files. Only exact existing Prettier transformations were applied. The complete hosted formatting command now exits 0; hashes and proof are in `foundation-phase17-format-proof.json` and `foundation-phase17-final-format.log`. No runtime semantics were changed by that cleanup. Fresh hosted gates remain pending.
