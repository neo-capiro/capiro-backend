# Normal pinned parser registry installation

This is an environment continuation of PR17, not a code-completion gate attributed to a missing cache. Exact source `afee9c4251c4c21417916bc4a02007283b67543b` keeps htmlparser2@8.0.2. The six-package isolated lock below is a dependency-closure projection of the existing lockfile: every package/snapshot/version/integrity entry is preserved. No registry URL, credential, source dependency or checksum was changed.

The already installed pnpm11.25.0 was used for this isolated download attempt; repository packageManager/Docker build remain pnpm@9.12.0. Use the normal repository-pinned package manager in a fresh authorized build environment. Scripts were suppressed to keep this pure dependency installation from executing unrelated lifecycle/native/database operations; compiler/runtime checks remain unchanged.

Working directory: `/tmp/capiro-pinned-parser-install-20261014`. Portable `parser-install/package.json` and `parser-install/pnpm-lock.yaml` are the exact attempted inputs.

```sh
pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace --registry=https://registry.npmjs.org --store-dir=/tmp/capiro-pinned-parser-install-20261014/store --reporter=append-only --network-concurrency=1 --fetch-retries=0 --fetch-timeout=30000
```

Actual second command output, session22640, exit1 (excerpts; full output remains in the original execution transcript):

```text
Lockfile is up to date, resolution step is skipped
Packages: +6
✓ Lockfile passes supply-chain policies (6 entries in 318ms)
[ERR_PNPM_ENOSPC] Failed to add tarball from "https://registry.npmjs.org/htmlparser2/-/htmlparser2-8.0.2.tgz" to store: ENOSPC: no space left on device, write
```

The first wrapper's gzip close also failed with `OSError: [Errno 28] No space left on device`, so it did not preserve child stdout/receipt. No result for that child is invented. The exact error and traceback are retained in the tool transcript; the second direct CLI run supplied the observed installer error. Neither command remains active. No successful installation or Workspace compiler rerun is claimed.

Before installation, /workspace had24KiB and /tmp60KiB free. The failed store and attempted manifests are preserved losslessly in `parser-install-failed-state.tar.gz`: all11 archived file hashes matched originals before only the newly failed installer store was removed. The attempted package store includes pnpm's local SQLite bookkeeping; no application database or migration was accessed. Previously reviewed source, native artifacts, shared caches and evidence were untouched. The archive/lock fingerprints and command are in REGISTRY-INSTALL-RESULT.json.

The smallest required change is writable disk capacity for this six-package frozen install and qualification outputs.100MiB free headroom is a practical provision, not a measured minimum. No credential, membership, identity, privilege, network/security change or new API is indicated by this error. An authorized environment with the ordinary existing toolchain/cache and a writable package store can run the same pinned graph, then rerun Workspace's complete configured program and independent checks. Keep normal full-service image/native/DB/Clerk/origin/worker-owner verification distinct from compiler evidence; those gates remain open, with no live operation inferred.
