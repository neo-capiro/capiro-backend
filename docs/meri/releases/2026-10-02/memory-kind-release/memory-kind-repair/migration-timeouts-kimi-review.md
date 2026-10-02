PASS

**Verdict:** The delta satisfies all root requirements and correctly adapts owned-PG tests.

**Migration (migration.sql):** Adds explicit `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';` wrapping the single atomic `ALTER ... DROP/ADD CONSTRAINT` pair, terminated with `COMMIT;`. This ensures one failed statement never exposes partial widened checks, regardless of operator environment propagation. Underlying9kind and IS TRUE payload predicates unchanged per commit 8c7a7020ce44e25991c52f7b07146891478700f9.

**Test harness (verify-memory-version-kind-migration.test.mjs):** 
- Creates random owned namespace outside any enclosing transaction; executes production SQL verbatim (no nested COMMIT illusion).
- Drops verified namespace plus asserts absence in `finally`, ensuring isolation.
- Individual data writes use own `BEGIN/ROLLBACK`; production migration failure uses file's own `BEGIN` and test `ROLLBACK`.
- Tests retain actual historical activation trigger and original checks, with exact typed valid/crossTenant/unknown/malformed negatives.
- New lock-conflict test: second connection holds `ACCESS SHARE`, causing `55P03` at ~5.1s, verifies constraints unchanged and caller 2s/10s timeouts restored.

28 tests passed, 0 skips claimed. No live runs; controls future database promotion. Source comment on NULL hole is documentation-only; no model behavior change. Full 450 fresh/upgrade and schemaChange release qualification remain root-owned pending.