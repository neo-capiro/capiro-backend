# Phase 9 integrated release rehearsal evidence

- HEAD: `ca3f372b0abfc75e06d0b031e89c18f2cd640e01`
- merge-base: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- origin/main: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- gate.ok: **true**
- generated: 2026-07-31T02:38:07.787Z

## Blockers
- (none)

## Warnings / base-proven
- soft-fail prettier_pe_surface failed on HEAD (exit 1); base comparison missing — fail closed
- soft-fail rls_phase_c_rehearsal failed on HEAD (exit 127); base comparison missing — fail closed

## Outcomes
- `install_frozen` exit=0
- `prisma_validate` exit=0 (2353ms)
- `prisma_generate` exit=0 (4943ms)
- `shared_build` exit=0 (1696ms)
- `shared_typecheck` exit=0 (1700ms)
- `api_typecheck` exit=0 (21794ms)
- `workspace_typecheck` exit=0 (7389ms)
- `web_typecheck` exit=0 (4181ms)
- `web_build` exit=0 (27667ms)
- `typecheck_pe_scripts` exit=0 (2296ms)
- `verify_pe_phase_a` exit=0 (2104ms)
- `verify_pe_phase_b` exit=0 (6725ms)
- `verify_pe_phase_c` exit=0 (7287ms)
- `verify_pe_phase_d` exit=0 (6612ms)
- `verify_pe_phase_e` exit=0 (7167ms)
- `verify_pe_phase_f` exit=0 (6360ms)
- `verify_pe_phase_g` exit=0 (6385ms)
- `verify_pe_phase_i` exit=0 (7252ms)
- `verify_pe_phase_j` exit=0 (7845ms)
- `verify_pe_phase_k` exit=0 (13764ms)
- `test_pe_trust` exit=0 (7593ms)
- `full_pe_api_tests` exit=0 (10563ms)
- `workspace_pe_tests` exit=0 (8084ms)
- `web_pe_tests` exit=0 (27857ms)
- `prettier_pe_surface` exit=1 (3864ms)
- `git_diff_check` exit=0 (177ms)
- `transport_absent` exit=0
- `migration_guards_offline` exit=0 (7566ms)
- `clean_upgrade_migrate_replay` exit=0 (49893ms)
- `rls_phase_c_rehearsal` exit=127 (273ms)
- `extended_loader_dry_run_matrix` exit=0

## Honesty

- This file is machine + implementer evidence, **not** independent REVIEW PASS.
- Grounded-field goldens remain SYNTHETIC / NOT human-reviewed (Phase K6).
- No shared-env migrate/deploy/ingestion/email/LlamaParse/Secrets Manager in this phase.
