# Approved fixture retirement evidence qualification

Source: ef1517996 (including 1b2641e7c); base e81d83ce2.

The canonical memory store now exposes internal retirement evidence readback. It verifies retained approved candidate/item content and lineage, changed item version, unchanged candidate version, exact synthetic marker, canonical revocation audit, cleanup intent, and observed absence of the clio source and item embeddings. The caller must still have active database membership with the actual role and pass current canonical read policy, including client walls and private ownership. The method returns identifiers/versions, not memory bodies. No controller or DTO exposes it. Ordinary forget behavior is preserved.

The fixture-only canonical writer binds the actual PostgreSQL revoked_at epoch into its immutable transition metadata in the same mutation transaction. Readback compares that value with the retained item. Audit occurred_at is deliberately not used as a proxy: actual output showed revoked_at 2026-09-29 05:32:29.939109+00 and occurred_at 2026-09-29 05:32:29.958+00. An attempted equality predicate failed five of 28 database checks (exit 1), and a focused reproduction failed with those direct timestamps. The earlier static review accepted that false premise and is superseded by the corrected-source review.

PASS, final qualification with actual exit 0:

- API production build with the explicit epoch binding.
- 28 actual local PostgreSQL tests. These include successful stable readback without writes, client/private access refusal, membership/role changes, and 11 isolated corruption cases covering timestamp, content, hold, revoker, candidate lineage, audit metadata/state, cleanup intent, clio restoration and embedding restoration. Existing approval, revocation, contention, rollback and pending CLI lifecycle checks remain included.
- 51 ordinary memory-store, verbs and governance-action regressions in four suites.
- Changed-source formatting and whitespace checks.
- Independent Hermes/Bedrock moonshotai.kimi-k2.5 static review of ef1517996: SCOPED PASS, exit 0. It did not execute tests. Existing candidate/item rows are locked during validation; an empty projection SELECT FOR UPDATE does not prevent phantom inserts. Proof describes observed retained state, not a guarantee against arbitrary future writes. A cleanup intent is not proof that every external projection worker has completed.

Evidence is in C:/dev/cap-meri-foundation-evidence: approved-retirement-proof-bound-build, approved-retirement-proof-bound-postgres, approved-retirement-proof-bound-unit logs and exit receipts; review-approved-retirement-proof-bound JSONL/exit/usage; failed approved-retirement-proof-final-postgres and approved-retirement-timestamp-baseline logs/exit receipts. The final database log prints actual retained proof IDs and independently observed differing timestamps.

The database suite uses an owned minimal local schema with test-local governance gates and stubbed post-commit provider/embedding dispatch. Fault injection modifies only that schema; production audit immutability is not disabled. The schema and temporary CLI files are removed. Full RLS, provider sinks and served acceptance are not qualified. No shared database, AWS service, route, model policy, cohort or flag changed.

Approved retirement still needs adapter/CLI plan and receipt integration. This service proof alone cannot satisfy existing reset or LIVE capture gates. Other fixture owners, trusted collectors, original 75/CD7/CW8 and applicable memory acceptance, hosted CI, database release clearance and deployment remain open.
