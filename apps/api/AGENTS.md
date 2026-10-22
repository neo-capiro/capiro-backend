# Preview Core API instructions

Apply root AGENTS.md. Agent 3 owns briefed app domains; agent 4 owns briefed Core-for-Meri bootstrap/application-authority. Coordinate auth, Prisma schema/migration IDs and shared files with Codex; one writer per exact file/phase.

Before changing application-authority endpoints inspect Meri consumers, current tenant/actor/client binding and server-only frontend proxies. Preserve current-authority semantics and tenant isolation. Package/lock/schema edits require regeneration of the runtime closure contract and Prisma pins (PRs #107/#109); never loosen probes.

Use targeted Jest paths through the package test script and required typecheck/build/lint. Isolated PostgreSQL16 only for tests. Production image qualification requires in-image static/runtime probes, isolated DB gates and exact-digest scan. Clone migration is a separate snapshot-first shipping operation, never an install/test prerequisite. Keep preview flags as stated in root instructions.
