# Exact first-approval continuation qualification

Tested source823edc1110a02082a06a4ff90cbaaa71f83b4e15 passes16 actual
PostgreSQL/CLI/packaging checks with zero skips and26 offline Promptfoo/custom
evaluations. The parent membership repair qualification retains its25 scoped
checks,27 API tests and full API typecheck; these are prior baseline evidence.

Only the original pending first approval may continue. Current database state
must match both historical STARTED claim hashes, the original recipe and run,
candidate version, existing authorization and empty downstream state. A fresh
plan binds current tenant version/settings, then one new continuation marker is
claimed atomically. Both previous claims are preserved and checked again at
completion. Canonical approval and unchanged fixture stages are reused. There
is no clear/reset path, general retry, grant change or migration.

Independent Hermes/Bedrock Kimi review passed with process exit0 and no tools.
The review's statement that one racing continuation succeeds means one reaches
the canonical approval; the actual injected42501 test rejects both calls and
checks rollback, unchanged claims and no projection. It is not a live approval.
Root independently reviewed the source delta and reran the composed16 checks.

The c22 deployed read-only diagnostic separately proved original SQLSTATE42883
and corrected query planning, with both claims/candidate unchanged. A qualified
new image and separately reviewed fixed operator are still required before any
live continuation. Original model turns and full live acceptance remain NOT_RUN.
