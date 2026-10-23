# Core API instructions

Apply [root instructions](../../AGENTS.md). Root assigns exact A/Core domain and U/Core-for-Meri files; coordinate auth, Prisma schema/migration IDs, contracts and shared files before edits. One writer owns each file/phase.

Core is the canonical authorization owner for identity, membership, selected client/General and walls. Inspect Meri consumers and server-only frontend proxies before changing application-authority or tool endpoints. Preserve read parity and negative tenant/client/wall/revocation tests. Do not rebuild Meri's superseded per-operation authority layers; remove duplicate wrappers only after lower-layer enforcement is proven.

Package/lock/schema edits require the runtime closure contract and Prisma-pin regeneration (PRs #107/#109). Keep controllers thin, reuse existing domain handlers and preserve generated outputs that reproduce byte-identically. Never loosen probes or weaken assertions.

Use targeted Jest paths through the package script and required affected typecheck/build/lint. Root coordinates isolated PostgreSQL 16 and image gates in WSL Codex-Gates. ARM64 release qualification includes in-image static/runtime probes, isolated DB gates and exact-digest scan. Clone migration is a separate root-owned, snapshot-first operation, never an install/test prerequisite. There is no blanket Wave 2 hold; remaining feature activation follows current source qualification and live acceptance.
