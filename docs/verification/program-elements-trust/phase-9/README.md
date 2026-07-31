# Phase 9 integrated release rehearsal evidence

- HEAD: `255098977509c9b06e7142f0624fa4822dfadb36`
- merge-base: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- origin/main: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- gate.ok: **true**
- generated: 2026-07-31T03:10:08.886Z

## Blockers
- (none)

## Warnings / base-proven
- soft-fail prettier_pe_surface failed on HEAD (exit 1); base comparison missing — fail closed

## Outcomes
- `install_frozen` exit=0
- `prisma_validate` exit=0 (2468ms)
- `prisma_generate` exit=0 (5199ms)
- `shared_build` exit=0 (1786ms)
- `shared_typecheck` exit=0 (1753ms)
- `api_typecheck` exit=0 (21239ms)
- `workspace_typecheck` exit=0 (7612ms)
- `web_typecheck` exit=0 (4384ms)
- `web_build` exit=0 (24860ms)
- `typecheck_pe_scripts` exit=0 (2502ms)
- `verify_pe_phase_a` exit=0 (2147ms)
- `verify_pe_phase_b` exit=0 (7273ms)
- `verify_pe_phase_c` exit=0 (7997ms)
- `verify_pe_phase_d` exit=0 (7163ms)
- `verify_pe_phase_e` exit=0 (7635ms)
- `verify_pe_phase_f` exit=0 (6740ms)
- `verify_pe_phase_g` exit=0 (6738ms)
- `verify_pe_phase_i` exit=0 (8892ms)
- `verify_pe_phase_j` exit=0 (10178ms)
- `verify_pe_phase_k` exit=0 (15437ms)
- `test_pe_trust` exit=0 (7887ms)
- `full_pe_api_tests` exit=0 (11189ms)
- `workspace_pe_tests` exit=0 (8563ms)
- `web_pe_tests` exit=0 (32325ms)
- `prettier_pe_surface` exit=1 (4856ms)
- `git_diff_check` exit=0 (217ms)
- `transport_absent` exit=0
- `migration_guards_offline` exit=0 (8158ms)
- `clean_upgrade_migrate_replay` exit=0 (54760ms)
- `rls_phase_c_rehearsal` exit=0 (245ms)
- `extended_loader_dry_run_matrix` exit=0

## Honesty

- This file is machine + implementer evidence, **not** independent REVIEW PASS.
- Grounded-field goldens remain SYNTHETIC / NOT human-reviewed (Phase K6).
- No shared-env migrate/deploy/ingestion/email/LlamaParse/Secrets Manager in this phase.
