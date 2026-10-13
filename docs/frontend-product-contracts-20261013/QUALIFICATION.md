# Comment calendar source qualification

Frozen code: `2e18581dbb096dae36505f5a787c018c1e4259fa`, tree `951fdf6eed7cfd81de03ba22434451f0f6fa6315`. Base: accepted PR2468 `35374ac826edf10c84061b255380d1165538b6b9`, tree `67f4171db2ee7a1c0eb629dd050ede435d50ad28`. Three API source paths change: the existing Federal Register controller/service and the new comment-calendar spec. No schema, migration, module registration, provider or source/artifact policy changes.

| Check | Final outcome | Scope |
| --- | --- | --- |
| Affected Jest | 29 passed, 0 failed, 0 skipped; two suites | 16 cached comment cases plus 13 existing authoritative effective-calendar cases; mocked source only |
| Strict API TypeScript | Exit 0, 137.307 seconds | Actual API tsconfig with `noEmit`, cold owned build info |
| Actual Nest build | Exit 0, 103.215 seconds | Actual Nest CLI and inherited build tsconfig; owned temporary output |
| Emitted syntax | Two changed production JavaScript modules pass `node --check` | Inventory and hashes captured before owned output retirement |
| Source composition | 26,401 base entries unchanged, 33 qualified authority inputs unchanged | Git mode/blob identities; protected reporting body not inspected |
| Existing Federal Register methods | Six existing members byte-identical | Includes effective calendar, list/detail, upcoming deadlines and agency read |

The initial test run also passed 29 cases. The first strict type check found TS2532 in a test's direct optional mock-tuple access. The assertion was changed to `toHaveBeenCalledWith` without changing runtime code; both affected suites and the full strict compiler were rerun. Original logs, results and receipts are preserved under `evidence/initial-*`, with historical path bindings in `original-check-bindings.json`. A dependency-link setup error before tests is also preserved: the host needed existing scoped package directories as well as resolved symlinks, not a flat list.

All checks use existing cached tooling. There was no installation, Prisma generation/download, database or migration execution, provider refresh, customer mutation, AppModule acceptance, AWS operation, deployment or main merge. The Jest preload refuses network/listen/DNS/HTTP/fetch/child execution and reads of `.env` and the protected reporting source. Node 24.19.0 on this host is not the approved Alpine/musl artifact runtime; this evidence does not qualify native PostgreSQL/RLS, live publisher content, deployed roles, TLS or artifact ABI.

The response's raw publisher-format flag remains false. Canonical midnight cached values can be projected as date-only comment entries, but ingestion does not retain the raw publisher string and does not establish current or complete publisher coverage. Effective-date evidence stays under its existing independent owner. The approved PROS-024 pinned Workspace copy and queued PR2469 bills cleanup are not implemented or consumed by this publication.

The existing layered checksum/qualification indices remain on the exact accepted ancestor. This packet carries only its new finite checksums and a compact base-preservation audit; no inherited evidence is discarded or restamped.
