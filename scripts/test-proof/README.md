# scripts/test-proof — five-runner test-name proof

Supporting infrastructure for CleanUp1/2/3: dump every test occurrence across
all runners and diff two dumps to prove that no test disappeared.

* `../dump-test-names.mjs` — discover packages, run their own runner (or import
  existing reports), write a canonical JSON dump.
* `../diff-test-names.mjs` — diff two dumps; only additions / explicit
  renames / explicit twinned removals / gained-or-acknowledged scope pass.
  Fail-closed: both inputs must be validated canonical dumps; non-passing or
  incomplete execution evidence, a preserved-name status regression, or a
  lost/changed target tier all block unless explicitly acknowledged.
* Full documentation: `docs/plans/cleanup1-test-proof-tooling.md`.

Run the fixture tests (no workspace dependencies, no credentials):

```bash
node scripts/test-proof/run-fixtures.mjs
```

Quick demonstration:

```bash
node scripts/dump-test-names.mjs --import manifest.json --out after.json
node scripts/diff-test-names.mjs --before before.json --after after.json
```

Everything here is read-only tooling: it deletes nothing and consolidates
nothing. It never reports a static-regex count as an executed test count, and it
keeps every occurrence — two identical fullName tests are two entries.
