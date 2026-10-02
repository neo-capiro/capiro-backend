# Guarded membership and memory UI readiness repair

Tested source280828b3256af2e1b69662b0867290239943cb6a passes25 Node/PostgreSQL/Chromium
checks with zero skips,27 API checks, full API typecheck and26 Promptfoo/custom cases.
The previous c22 composed181Node/40API qualification remains the parent baseline.

Three synthetic membership guards compared the PostgreSQL tenant_role enum with
Prisma's text parameter. Actual generated Prisma reproduces P2010/42883; casting
the role column to text preserves exact membership matching and fixes the query.
The safe error classifier now retains42883 without raw database messages. The
tests use real enum types and actual Prisma parameters; document cleanup checks
guard/CAS stages only, not S3 deletion. No database migration or grant change.

Case17's actual browser diagnostic proves the harness checked optional panel
controls before the React rail mounted. Authenticated actor/owner reads returned
200 and six proposals; the later screenshot shows the context entry visible.
The collector now awaits the existing rail before choosing those controls.
Native Chromium tests reproduce the old failure and verify all three entry states.
No Web code changed and no Web rollout is required for this collector repair.

Memory and UI fixes have actual Hermes/Bedrock Kimi PASS/exit0 reviews. Document
cleanup has root peer PASS and a Kimi source PASS with worker exit1; that process
limitation is retained and is not represented as a passing worker execution.

API-only candidate release remains separate. Preserve the original case01 and
recovery STARTED claims; read-only deployed query diagnosis and a separately
admitted continuation are required before fixture writes. Original live75/CD7/CW8,
applicable memory/variants and human grading remain incomplete. No original row
is claimed complete. Defense Chat remains excluded.

Shared policy39590a3bfc57ce03b0411ff7912a7c8d99deb70c; machine map2026-09-30T00:21:48Z.

Actual deployed read-only diagnostic v2 passed on c22: original typed-text query
SQLSTATE42883 and role::text EXPLAIN success; both STARTED claims and candidate
xmin113340385 unchanged. The initial catalog NAME[] parser failure is retained.
This is query diagnosis, not fixture recovery or original live acceptance.
