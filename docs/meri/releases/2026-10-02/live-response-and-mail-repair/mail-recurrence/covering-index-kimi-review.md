PASS

The migration correctly targets the actual query bottleneck: the thread heap walk via tenant/client/time index (49775/54179 cost units). By covering (tenant_id, connection_id, id) INCLUDE (client_id), the index aligns exactly with the existing query's join predicates on mail_threads without altering RLS, security, or search semantics.

DDL safety is properly bounded: explicit transaction with LOCAL lock_timeout=5s and statement_timeout=30s prevents unbounded blocking; on timeout, the transaction rolls back leaving no partial index. The test script validates this 55P03 path and confirms zero leftover catalog residue.

The verification fixture exercises the actual transpiled query source under FORCE RLS with a NOBYPASSRLS non-owner role, tenant isolation (cross-tenant query returns zero rows), and result identity across 10 scenarios including Unicode, literal escapes, and six-field matching. Before/after EXPLAIN shows Index Only Scan with heapFetches=0, cost reduction 27634→24145, and confirms the planner selects the new covering index under RLS constraints.

The candidate changes are strictly additive migration + test script; zero query/provider/API/route/security code changes. No GIN, leakproof, or policy alterations. Ready for actual live EXPLAIN validation and 451 qualification by release owner.