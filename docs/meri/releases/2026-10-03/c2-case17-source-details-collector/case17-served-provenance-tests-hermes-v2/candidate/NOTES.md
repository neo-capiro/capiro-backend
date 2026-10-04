Delivered the two requested focused test files under their original repository-relative paths:

- `evals/meri/live-v1/tests/case17-memory-ui.test.mjs`: positive API fixture rows now carry exact synthetic-fixture recorded-source references bound to ownership marker hashes; added negative cases for absent, unknown, malformed, swapped, duplicated, and extra-field API references.
- `evals/meri/live-v1/tests/case17-saved-checks.test.mjs`: saved evidence fixtures now include the expected recorded-source proof; added negative proof and API-reference cases exercised against both rounds (rehashing mutated API pages), retained the positive post-reload reorder case, and updated the real-browser markup fixture with native source details and exact labels.

No helper modules or other sources were changed. Tests were not run. This is only the source-UI slice; full original Case17 and the human rubric remain NOT_RUN. No new acceptance claim is made.
