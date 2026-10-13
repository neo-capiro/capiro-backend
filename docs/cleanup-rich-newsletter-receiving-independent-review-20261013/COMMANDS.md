Commands ran from `/tmp/capirov2-cleanup-strategy-template-independent-review`. Node is the existing local executable; TypeScript comes from `/workspace/capirov2/apps/api/node_modules/typescript`. No package manager or installation was invoked. The scripts read only their captured source bindings, cached compiler, own data and explicit read-only Git paths. The public loader refuses non-relative dependencies and private/runtime modules. The method probes extract declarations and use fake ports, without the service import graph.

For each command below, stdout and stderr are separate immutable files with the same prefix. All scripts that write JSON use exclusive creation. Source labels identify captured Git bytes, not a floating working tree. The original `01`/`03` inputs and expected outcomes were retained for later replays; only the loader, output label and exact source attribution changed.

| Command (`node evidence/...`, relative to this packet) | Exit | Evidence |
| --- | --- | --- |
| `01-producer-boundary-probe.cjs` | 1 | Original 8f: six genuine receiving mismatches |
| `02-current-owner-probe.cjs` | 1 | Initial harness ReferenceError, preserved |
| `03-current-owner-probe.cjs` | 1 | Corrected harness, original 8f: five mismatches |
| `capture-source.cjs 7949d079b1b46acf9c18c86898d6eedf9290428a frozen794` | 0 | `04-capture-794.*` |
| `05-producer-boundary-794.cjs` with `REVIEW_BINDINGS=frozen794-BINDINGS.json` | 0 | Six passing original cases |
| `06-current-owner-794.cjs` with the same bindings | 1 | Three passes, two malformed timestamp escapes |
| `capture-source.cjs 37d574a35cd6d9aef79239a830b588fe1bd9769f frozen37` | 0 | `07-capture-37.*` |
| `08-producer-boundary-37.cjs` with `REVIEW_BINDINGS=frozen37-BINDINGS.json` | 0 | Six passing original cases |
| `09-current-owner-37.cjs` with the same bindings | 0 | Five passing original cases |
| `10-method-authority-probe.cjs` with the same bindings | 0 | 41 actual-method fake-port checks |
| `11-receiving-independent.cjs` with the same bindings | 1 | 129+70 passes, incorrect truthy-array exit predicate preserved |
| `12-source-closure.cjs` with the same bindings | 1 | Metadata subprocess ENOBUFS preserved |
| `13-receiving-independent.cjs` with the same bindings | 0 | Corrected exit predicate, unchanged 199 passing cases |
| `14-source-closure.cjs` with the same bindings | 0 | Corrected metadata buffer, 40 preservation checks |
| `15-author-packet-hashes.cjs` | 0 | 60 immutable author evidence hashes |

`git diff --check c07d00e27fdda64dfbd13c36d0ac433c81d9f7f4 37d574a35cd6d9aef79239a830b588fe1bd9769f -- <the nine paths in evidence/14-source-closure.json>` returned 0, with empty `16-source-diff-check.stdout` and `.stderr`. The `17-original-evidence-integrity.json` receipt was produced by rereading every original `INITIAL-SHA256.json` entry with SHA-256; all 38 original entries matched. The final index is likewise computed from physical bytes and verified against committed Git bytes when sealing this packet.
