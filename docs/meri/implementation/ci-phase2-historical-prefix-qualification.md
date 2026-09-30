# Phase2 historical upgrade fixture

The b40d25e70 hosted job109237089817 passes the full fresh migration chain and its original RLS, append-only, tenant-isolation and proposal-immutability assertions. The ordered-upgrade fixture then fails: its supposed pre-Phase2 history removes only the Phase2 migration while retaining later migrations. The later reasoning-conversations migration references outreach_sessions, which Phase2 creates.

The temporary Prisma copy now retains every migration strictly before the exact Phase2 boundary and excludes that boundary plus all descendants. Schema and lock files remain unchanged; no production migration bytes change. The original main rehearsal function, complete fresh chain, exact Phase2 SQL application, legacy sentinel comparison and all invariant functions remain structurally AST-identical. This restores the documented historical-upgrade scenario; it does not replace the full-current fresh-chain gate.

PASS: 32 guard/prefix tests, including an actual filesystem copy preserving original bytes/source, both path separators, and the real repository migration inventory; 14 original helper/invariant/main functions compared structurally; scoped formatting and diff checks, all exit0. Test cleanup removes only the freshly created owned directory under C:/dev on Windows. No database was mutated by this patch's local checks.

Independent Hermes/Bedrock Kimi static review returns SCOPED PASS with exit0. Lead clarification: the old code removed only Phase2, not all later migrations. Full hosted ordered-upgrade execution remains required and NOT RUN locally. The shared database recovery release block is unaffected.

Evidence: C:/dev/cap-meri-foundation-evidence/ci-b40-109237089817.log, phase2-baseline-qualified-tests.log, phase2-baseline-assertion-preservation.json and review-phase2-historical-prefix*.
