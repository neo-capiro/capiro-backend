# Case14 integrated local collector review

Decision: PASS — local collector correctness, based on static review of the four requested files and `evidence/diff.txt`.

Scope reviewed: `case14-approval-capture.mjs`, `case14-approval-write-guard.mjs`, `case17-readonly-guard.mjs`, and `tests/case14-approval-write-guard.test.mjs`. No shell, cloud, application-source, or other files were changed. This review did not run tests; the reported focused-test results are lead-reported, not independently verified here. The final combined qualification was reported as still running.

Findings:

- Application-origin writes are denied by default. The only forwarded application write is one armed `POST` to the exact `os.capiro.ai` candidate-approval path, with no query/hash and the exact `{}` body. A second submission, wrong candidate, altered method/path/body, or non-armed request is denied.
- Preference `PUT`s are always aborted. They qualify as bounded exceptions only at the exact preference endpoint and in the `initial`/`afterReload` panel phases; receipt validation bounds their total and per-phase counts. Unexpected writes are counted as non-preference writes and make arming/approval evidence validation fail. Writes before intent fail `assertBeforeIntent()`/`arm()`; writes after arming invalidate the accounting checked before the approval is forwarded.
- Recall UI has no approval exception: its route uses deny-only accounting, and its evidence is rejected if any write falls outside the bounded preference category. It does not submit a recall turn.
- The collector preserves the existing scope, reviewer/tenant identity, deployment identity, and canonical owner checks. Approval evidence requires the before/after fixture identity, recipe/payload/text/source fields to match, verifies owner hashes, and checks the canonical approval decision and response. No evidence of scope broadening or weakening of those checks was found in the reviewed diff.

Limitations / separate live blocker:

- PASS is a code-review result, not a test or live-capture result. Do not treat the lead's test claims as independently verified, and do not infer that a live approval is authorized by this review.
- The separately reported blocker remains: canonical approval launches embedding providers outside the recall budget. That is outside this local collector review and remains unresolved; no live approval is authorized.
