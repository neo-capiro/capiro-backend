PASS

Independent file-only review of the supplied diff and four listed files. No actionable source bug or material missing Case14-specific security/correctness test found.

- Admission is narrow: `evidence/evals/meri/live-v1/lib/windows-capture-spend.py:224-235` requires the pinned exact-24 prefix for Case14, permits only one non-historical Case14 run, and retains the existing single-active-run and total/per-run ceiling checks. The Case14 reservation path is also enabled in the JS owner at `evidence/evals/meri/live-v1/capture-spend-aggregate.mjs:180-191`.
- The historical adoption prefix remains pinned to 20 events; the prospective extension does not globally broaden adoption. The native adoption guard still requires exactly 20 events and no active run at `evidence/evals/meri/live-v1/lib/windows-capture-spend.py:313-315`.
- Case14 settlement continues through the existing `currentCase14RecallAuthority` branch and existing evidence/budget validation at `evidence/evals/meri/live-v1/capture-spend-aggregate.mjs:227-259`; no settlement authority change is introduced.
- Relevant tests cover exact-24 resumption and costs, cap/replay/settlement rejection, earlier or edited prefixes, and owner contention: `evidence/evals/meri/live-v1/tests/capture-spend-fresh.unit.py:214-282` and `evidence/evals/meri/live-v1/tests/capture-spend-fresh.test.mjs:180-216`. Both suites separately preserve and verify the complete live journal bytes while using an isolated immutable 20-event fixture for historical adoption: Python lines 20-22, 45-48, 229-232; JS lines 13-23, 73-75.

I did not run tests or modify source. This review relies only on the supplied evidence; the reported Windows test results are not independently verified here.

Reviewed diff/evidence manifest: `evidence/diff.txt`, `evidence/manifest.json`.