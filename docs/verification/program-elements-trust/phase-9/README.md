# Phase 9 integrated release rehearsal evidence

- HEAD: `42b8bee7ecc4d20bbfee43a92a06521629ab3523`
- merge-base: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- origin/main: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- gate.ok: **true**
- generated: 2026-07-31T02:46:25.494Z

## Blockers
- (none)

## Warnings / base-proven
- soft-fail prettier_pe_surface failed on HEAD (exit 1); base comparison missing — fail closed
- soft-fail rls_phase_c_rehearsal failed on HEAD (exit 127); base comparison missing — fail closed

## Outcomes
- `install_frozen` exit=0
- `prisma_validate` exit=0 (2388ms)
- `prisma_generate` exit=0 (5268ms)
- `shared_build` exit=0 (1842ms)
- `shared_typecheck` exit=0 (1785ms)
- `api_typecheck` exit=0 (21904ms)
- `workspace_typecheck` exit=0 (7822ms)
- `web_typecheck` exit=0 (4392ms)
- `web_build` exit=0 (24986ms)
- `typecheck_pe_scripts` exit=0 (2524ms)
- `verify_pe_phase_a` exit=0 (2123ms)
- `verify_pe_phase_b` exit=0 (7688ms)
- `verify_pe_phase_c` exit=0 (9094ms)
- `verify_pe_phase_d` exit=0 (7923ms)
- `verify_pe_phase_e` exit=0 (8782ms)
- `verify_pe_phase_f` exit=0 (6847ms)
- `verify_pe_phase_g` exit=0 (6676ms)
- `verify_pe_phase_i` exit=0 (7660ms)
- `verify_pe_phase_j` exit=0 (8213ms)
- `verify_pe_phase_k` exit=0 (14990ms)
- `test_pe_trust` exit=0 (8843ms)
- `full_pe_api_tests` exit=0 (14670ms)
- `workspace_pe_tests` exit=0 (8163ms)
- `web_pe_tests` exit=0 (28798ms)
- `prettier_pe_surface` exit=1 (3888ms)
- `git_diff_check` exit=0 (161ms)
- `transport_absent` exit=0
- `migration_guards_offline` exit=0 (7810ms)
- `clean_upgrade_migrate_replay` exit=0 (52201ms)
- `rls_phase_c_rehearsal` exit=127 (250ms)
- `extended_loader_dry_run_matrix` exit=0

## Honesty

- This file is machine + implementer evidence, **not** independent REVIEW PASS.
- Grounded-field goldens remain SYNTHETIC / NOT human-reviewed (Phase K6).
- No shared-env migrate/deploy/ingestion/email/LlamaParse/Secrets Manager in this phase.
