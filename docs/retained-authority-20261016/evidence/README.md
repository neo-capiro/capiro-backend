# Evidence provenance and limits

These are byte-preserving snapshots of completed checks and reports. Copying the artifacts executed none of their harnesses. A later concrete source-review finding caused only the affected transport suite to rerun against its corrected source; its43-case successor and earlier42-case result are both preserved. No bearer, real credential, serialized signed envelope, private/public key material or live response body is included. Harnesses generate synthetic ephemeral keys in memory and report assertions/metadata without emitting their material.

## Original task locations

All paths below are under `C:/Users/neoma/Documents/Codex/2026-10-15/task-3/` unless stated otherwise. [COPY-INVENTORY.json](COPY-INVENTORY.json) binds each copied filename to its original absolute task path, byte count and SHA-256. Source and destination hashes matched before/after each copy.

| Artifact group | Original location | Interpretation |
| --- | --- | --- |
| Real-JCS/Ed25519 codec receipt, preflight failure and harness | Task-root `retained-codec-real-jcs-check*` | Final112 checks pass. Earlier preflight records0checks; no missing raw error stack is manufactured. |
| Parser receipt, harness and frozen-reference manifest | `current-authority-runtime/retained-read-parser*` and `RETAINED-REQUEST-FROZEN-REFERENCE.json` | Corrected22-case pure proof and its exact parser/source/dependency hashes. |
| Transport receipts, runner and raw stdout/stderr | `retained-transport-runtime/` | Corrected43-case pure proof plus preserved42-case predecessor; earlier0-case setup failures and superseded40-case proof remain described in the older receipt. Copied raw output uses the descriptive `transport-` filename prefix. |
| Four-source semantic receipts, checker, reports and launch outputs | `retained-authority-runtime/` | Initial128MiB old-space OOM, earlier256MiB pass and exact-source256MiB successor after the corrected HTTP dependency. Empty files are deliberately retained. |
| Historical scoped current-resource review | `current-authority-runtime/RETAINED-CURRENT-SOURCE-REVIEW.md` | Review only, bound to its own listed hashes. It predates later issuer/probe/native wiring and is not a whole-increment acceptance. |
| Date-realm fixture review/proof | `current-authority-runtime/FIXTURE-REVIEW.md` and `fixture-date-realm-proof.json` | Supporting context linked by the historical current-resource review, not retained source or membership qualification. |

Actual JCS was read from the existing `C:/Users/neoma/Documents/Codex/2026-10-15/task-4/meri-greenfield/node_modules/canonicalize/lib/canonicalize.js`, version5.1.0, SHA-256 `c1d0195af2a0748454b06af8f218e5c90415c19d39154d0058fee8229c12d859`. Its package and dependency hashes are recorded in the original receipts. No dependency installation, dependency copy, Meri source edit or runtime adoption followed from that read.

## Harness snapshots and byte hashes

Copied `.cjs` harnesses retain their original absolute paths, dependency resolution and original receipt destinations. They are audit snapshots, not commands to run from this directory. In particular, running a copied harness could write its original task receipt; no reproduction command is implied or authorized by this copy. The actual source specifications remain in their normal source paths.

Inventory and receipt hashes describe the original **working-file bytes**, including their captured LF/CRLF endings. Git may normalize text when a later source owner stages/publishes these files. A published Git blob can consequently have a different SHA-256 even when the rendered text is unchanged. Preserve the raw receipt's recorded hashes; do not rewrite them to fit a later blob. The final source owner must separately bind the published commit/tree and actual blob bytes, explain any newline-only difference, and reuse a test only when its exact-source applicability is established.

`WIRE.md` and `PRIVATE-PROBE.md` were not edited by consolidation. Their accepted working-file hashes are respectively `80b11ad1599c7886aeb9d694bb5d9741eb45600b833314490df90d3740416a17` and `e643d5fa91614313bca67911886b03e6dc22db891446a13e329ae82914256777`.

The final source manifest, focused Jest terminal receipt, complete successor review and publication pin are supplied separately by the source owner. Until those records exist, no unexecuted batch, mounted route, live authority or release is claimed.
