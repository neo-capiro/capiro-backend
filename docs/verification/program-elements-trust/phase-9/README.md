# Phase 9 integrated release rehearsal evidence

- HEAD: `cf9545d7e8879862a19bac4e82620eadf010c6b7`
- merge-base: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- origin/main: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- gate.ok: **true**
- generated: 2026-07-31T02:31:13.548Z

## Blockers
- (none)

## Warnings / base-proven
- soft-fail prettier_pe_surface failed on HEAD (exit 1); base comparison missing — fail closed
- soft-fail rls_phase_c_rehearsal failed on HEAD (exit 127); base comparison missing — fail closed

## Outcomes
- `install_frozen` exit=0
- `prisma_validate` exit=0 (2293ms)
- `prisma_generate` exit=0 (5060ms)
- `shared_build` exit=0 (1670ms)
- `shared_typecheck` exit=0 (1655ms)
- `api_typecheck` exit=0 (19982ms)
- `workspace_typecheck` exit=0 (7301ms)
- `web_typecheck` exit=0 (4106ms)
- `web_build` exit=0 (23326ms)
- `typecheck_pe_scripts` exit=0 (2322ms)
- `verify_pe_phase_a` exit=0 (2092ms)
- `verify_pe_phase_b` exit=0 (6718ms)
- `verify_pe_phase_c` exit=0 (7330ms)
- `verify_pe_phase_d` exit=0 (6672ms)
- `verify_pe_phase_e` exit=0 (7307ms)
- `verify_pe_phase_f` exit=0 (6315ms)
- `verify_pe_phase_g` exit=0 (6474ms)
- `verify_pe_phase_i` exit=0 (7190ms)
- `verify_pe_phase_j` exit=0 (7767ms)
- `verify_pe_phase_k` exit=0 (16867ms)
- `test_pe_trust` exit=0 (7487ms)
- `full_pe_api_tests` exit=0 (10656ms)
- `workspace_pe_tests` exit=0 (8058ms)
- `web_pe_tests` exit=0 (29146ms)
- `prettier_pe_surface` exit=1 (4413ms)
- `git_diff_check` exit=0 (154ms)
- `transport_absent` exit=0
- `migration_guards_offline` exit=0 (7605ms)
- `clean_upgrade_migrate_replay` exit=0 (43017ms)
- `rls_phase_c_rehearsal` exit=127 (283ms)
- `extended_loader_dry_run_matrix` exit=0

## Honesty

- This file is machine + implementer evidence, **not** independent REVIEW PASS.
- Grounded-field goldens remain SYNTHETIC / NOT human-reviewed (Phase K6).
- No shared-env migrate/deploy/ingestion/email/LlamaParse/Secrets Manager in this phase.
