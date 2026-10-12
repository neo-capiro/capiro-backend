# Bounded runtime command audit

Audited exact source61e9 before the three remaining runtime gates. `scripts/cleanup-runtime-equivalence.jest.cjs` selects the Node environment and isolated ts-jest transform, has no app/database setup or global setup, and imports only the cached transform. It does not invoke a generator, install, API bootstrap or default application test configuration. All selected test files and relevant imports/collaborators were inspected without touching the unpublished reporting owner.

| Scope | Existing tested boundary / real I/O exclusion |
| --- | --- |
| Tango (root-owned run; not repeated) | Selected REST tests construct clients with injected fake fetch implementations and synthetic API keys; unconfigured clients refuse before the fake transport. The clients read provided configuration rather than environment credentials. Frozen original pure helper declarations are extracted and evaluated for comparison. URL/Headers/Response and short abort timers are local objects; no real provider call is required. |
| Strategy | The three selected suites import pure frontmatter, template registry and report context modules plus Jest and filesystem fixture/template readers. Runtime imports remain local pure code; DTO/model imports are type-only. No Nest application, database, HTTP, credential or provider owner is instantiated. |
| Workspace | Selected suite imports the pure catalog/registry and thin `CascadeService`; the latter imports only the Nest decorator and catalog, with no Prisma or provider constructor. Before/after fresh-module VM comparisons use rejecting synthetic require callbacks and in-memory catalog values. |
| Meri | The selected test imports the pure dispatcher and extracts dispatch bodies as text. VM harness owners/authority are synthetic proxies and promises; sandbox `fetch`, `process`, `require` are undefined. No `MeriToolsService` provider graph, actual authority database, app module, model or external client is instantiated. |

Actual root aliases are run with the cached pnpm9.12 launcher and PATH shim. Private worktree-local Strategy/Workspace `node_modules` links point to existing installed cache directories; no common binding, product source or generated client was edited. The successful runs install or download nothing.

Two failed launch receipts precede success. First, the author omitted the provided PATH shim and the nested command selected the host fallback pnpm. It attempted automatic installation and failed at `mkdir /home/agent/.local/share/pnpm` with ENOENT before tests. This attempt is recorded; it is not described as a successful source-only run or permission bypass. The shim-only retry then failed because the new worktree had no private Strategy Jest binary. Adding the two local cache links enabled the unchanged aliases; neither failure was a test or source defect.

This audit is a bounded test setup inspection, not arbitrary OS/network containment or a native/PostgreSQL acceptance claim. Read-only GitHub metadata requests for frontend coordination are recorded separately; no product/provider HTTP or external message is part of the successful gates.
