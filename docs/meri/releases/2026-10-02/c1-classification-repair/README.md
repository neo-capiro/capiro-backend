# C1 classification repair — local qualification

Candidate source: `6c816139e1002d99f652e6a26177fd43ac8febcd`. Status: locally qualified; image publication, promotion and served acceptance remain pending. C1 remains open.

Two reproduced language boundaries caused unrelated evidence work: “Office Delta” created a financial comparison requirement, and “a failed search” created bill-status requirements. The planner now requires financial context for comparison words, recognizes named Delta subjects, and recognizes failed operational reads without suppressing explicit legislative questions. Actual financial-comparison and failed-source warnings remain.

[Qualification](qualification.json) records 360 core tests, 102 focused orchestrator tests, 37 API/mail tests including real local PostgreSQL cancellation/recovery, typecheck, 26 offline cases, exact source hashes and independent review. The [offline report](meri-offline-final.json) and [verified summary](meri-offline-final.summary.json) are retained. The initial API Jest process exhausted its default heap; the final run with an8GiB ceiling passed.

[Fresh browser baseline](browser-baseline.json) verifies the concise reply and zero task count, and reproduces the mailbox503 plus irrelevant vote lookup/footer. A separate list_emails attempt returned403HTML and remains unresolved. [Read-only Performance Insights](mail-incident.json) places the search COUNT query at the ten-second database execution limit, predominantly DataFileRead. The log query was paginated and incomplete; it is not evidence of absent server errors. No customer message content is retained.

The existing isolated mail SQL harness also passed all6 checks and10 before/after result comparisons, and the existing local task-scope suite passed6 tests. Those are synthetic local SQL evidence, not served known-result acceptance. The database uses task-owned loopback PostgreSQL16.15 binaries from [EDB](https://www.enterprisedb.com/download-postgresql-binaries). Its private configuration and data directory remain outside Git.

Hermes contributed the initial narrow planner diff using its existing configured model/provider. Lead review corrected positive financial regressions and incorporated the newly reproduced operational wording defect. A separate Codex reviewer approved the final three-file diff. [Hermes usage](hermes-usage.json) is estimated provider accounting.

No API/schema/model/flag changes are part of this candidate. Current orchestrator105 remains the rollback baseline; API515 and WebVNext388 are outside this release. Mail query performance is the next bounded repair. The original75 fixture clock and historical journal limitations remain separate and are not waived.
