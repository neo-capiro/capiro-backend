The physical prior worktree and prior native/source/package review heads remain untouched. Source authoring uses a virtual Git tree rooted at `523ef9167f05a33efdbdfbbfc08d5fc2e2679012`; no full checkout or whole PR adoption occurs.

Two exact published donor Git blobs were read through the GitHub blob endpoint, and only the same two base code files through the contents endpoint at `89107485cd8432d0c7f29544c94c570acc32deda`. Responses were decoded and their Git blob/SHA256 identities recorded in `DONOR-BINDINGS.json` and `BEFORE-BINDINGS.json`. No report or runtime-operator content was read. Nine canonical inputs were read with `git show 523ef916...:<explicit path>` and copied to the task-owned inert stages.

| Invocation | Working directory | Exit/result | Raw prefix |
| --- | --- | --- | --- |
| `node --test scripts/ci/newsletter-declared-edge.contract.spec.mjs` | Physical previous worktree | 1, wrong host/spec absent | `02-candidate-spec` |
| Same command | `/tmp/newsletter-header-adaptation-stage-20261013` | 0, 30/30 current candidate | `03-candidate-spec` |
| Same command | `/tmp/newsletter-header-before-stage-20261013` | 1, 29/30 current pins with unrepaired dictionary | `04-unfixed-spec` |
| Same command | `/tmp/newsletter-header-donor-stage-20261013` | 1, donor stale source pin, before collection | `05-donor-current-pin-refusal` |
| `node evidence/immutable-header-controls.mjs` | This packet's owning worktree | 0, expected before four escapes and after 82/82 | `06-immutable-header-controls` |
| `python evidence/inverse-and-bindings.py` | This packet's owning worktree | 0, two source paths, exact inverse, nine inputs and all 30 names | `07-inverse-and-bindings` |
| `git diff --check 523ef916... bdcb6b4... -- <two source paths>` | This packet's owning worktree | 0 | `08-source-diff-check` |

The independent reviewer can recreate a small stage with the two candidate Git blobs and the nine `CURRENT-BINDINGS.json` inputs, then run the actual spec directly. No app bootstrap, environment configuration, shell execution, provider, AWS, HTTP request, SQL or native tool is needed. The helper imports only built-in crypto; the spec imports built-in test/assert/fs and that helper. The source inputs are byte data only. The immutable-header corpus imports the preserved before/candidate helper snapshots and the same source bytes; all request objects and header objects are frozen, and it asserts the expected four baseline escapes rather than pretending they passed.
