# Synthetic fixture boundary qualification

Verdict: PASS for manifest/provisioner boundary repair only. Full native-owner assembly and live acceptance remain incomplete.

The memory proposal declared initially absent now produces a read-only absence assertion, never a create. A row present at plan, apply or verification fails the check without deleting or overwriting it. Successful absence assertions are excluded from reset. This establishes absence at the time of each read, not a lock preventing subsequent application writes.

Document uploader bindings are selected per tenant, with explicit actor identity recorded and checked against the deterministic canonical uploader ID. A cross-tenant, absent or malformed actor makes the source unavailable. Manifest validation recomputes ownership markers and physical IDs; availability failures carry a reason. Pending memory, transition audit, hearing/media evidence and research events retain distinct canonical owners. Client profiles are not misrepresented as capabilities.

Validation: 23 tests pass with exit 0, including the existing owned local PostgreSQL guard test, plus scoped formatting and diff checks. Independent Hermes/Bedrock Kimi static review: SCOPED PASS, worker exit 0. The PostgreSQL test uses minimal local tables and a test adapter; it does not qualify production service DI, lifecycle transitions, uploads or capiro-dev provisioning. The review's informational remark about an empty diff-check log is not a defect: git diff --check exits 0 silently. Its suggestion to duplicate absence declarations in the lock is unnecessary: the lock already binds the frozen fixture hash. No extra approval is inferred from those remarks.

Evidence: C:/dev/cap-meri-foundation-evidence/fixture-boundaries-gates.json, fixture-boundaries-tests.log, fixture-boundaries-source-manifest.json, fixture-boundaries-review.diff, review-fixture-boundaries-report.md and review-fixture-boundaries-exit.json. Original unfinished worker changes are preserved in synthetic-native-worker-before-lead.patch and the donor worktree. They remain excluded from this commit.

NOT RUN / incomplete: remaining native owner service adapters (placeholder actors and missing authoritative ownership readbacks), guarded document erasure, full owner runtime assembly, capiro-dev fixture apply/reset, full File01 acceptance, main integration and deployment. No shared environment records or configuration changed. Local test side effect: dedicated temporary PostgreSQL schema created and removed by the test.
