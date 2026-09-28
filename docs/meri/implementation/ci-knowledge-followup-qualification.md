# Knowledge workflow follow-up prerequisites

Scope: six workflow fixes on 9155e8d5c. PASS for local named checks; full hosted CI is not yet passing.

Hosted evidence at this exact base: Phase9 patch hygiene failed with shallow HEAD^; Phase13 Prisma validation lacked DATABASE_URL; Phase11/14/16/18 test commands exhausted the default 2GB Node heap. The workflows now fetch two commits where HEAD^ is required, use a nonconnectable loopback URL only for Phase13 schema validation/generation, and set a bounded 6GB heap in the four affected jobs. All existing steps/checks remain. No application or deployment configuration changed.

Validation: 156 API tests in 28 suites plus 14 core tests in two suites exit 0 with the bounded heap. Scoped formatting exits 0. Strict YAML parsing rejects duplicate keys and a parsed-tree comparison proves only intended semantic changes, including preserving Phase11 DATABASE_URL. The lead corrected a duplicate env mapping before publishing. The first local test selector wrongly mixed core paths into API selection and stopped before execution; the corrected split produced these actual results. Initial independent review inspected the wrong checkout and is superseded by final Hermes/Bedrock Kimi SCOPED PASS on the immutable diff and hash manifest.

Evidence root C:/dev/cap-meri-foundation-evidence: ci-9155-failure-summary.json and per-run raw logs; ci-followup-capacity-gates.json/logs; ci-followup-yaml-proof.json and verify-ci-followup-yaml.cjs; review-ci-followup-final-report.md and exit JSON.

Remaining hosted failures are not waived: shared formatting, embedding architecture guard, historical Outreach scope guard, disposable database role prerequisites in other workflows, and unrelated integration fixtures. No main, AWS, shared database, synthetic-cohort enablement or production canary changes.
