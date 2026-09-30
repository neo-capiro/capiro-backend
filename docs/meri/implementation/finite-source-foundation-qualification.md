# Finite source integration qualification

This change consolidates source candidate `615fa610d77ae7e4348fd1972c536e7d377e6134` into durable/provider foundation `4ba275d1e0d7bafd89d69215350bf106d9962c91`. It adds current-owner replay proofs for Monday, bill status/text, web pages, chat attachments, and prior research evidence. Existing meeting/task/action/mail proofs and canonical execution inputs remain in place. Attachment reads retain the current conversation, version, content-hash, and post-read authorization gates.

Web retrieval pins public DNS addresses per redirect and uses one deadline for resolution, fetch, body consumption, and extraction. PDF extraction runs in a bounded child process, terminated and joined on deadline. The rejected worker-thread implementation caused a native Windows Node crash and is not included.

## PASS: bounded integration checks

- Shared/core builds, API/orchestrator type checks, and scoped formatting exited 0.
- Combined API verification: 275 tests across 14 suites, exit 0. The first invocation selected a nonexistent test path; that setup failure is retained separately and superseded by the corrected run.
- An additional Monday cursor regression passed in the 19-test source-family suite, exit 0. An omitted exhausted cursor matches null; a non-null cursor, malformed cursor, or incomplete pagination flags deny replay.
- Hermes/Kimi independently reviewed the merged changes and cleared its final scope. Its initial cursor finding and incorrect native-proof paraphrase were corrected against the actual owner contract and runtime regression.

Evidence is retained under `C:/dev/cap-meri-foundation-evidence`: `finite-integration-gates.json`, `finite-integration-api-tests.log`, `finite-monday-cursor-proof-run.log`, `finite-conflict-resolutions.json`, and `review-finite-integration-disposition-report.md`.

## NOT RUN: release acceptance

These checks do not establish full File01 acceptance, shared-environment acceptance, owner acceptance, main integration, or deployment. No main branch, routing, flags, or AWS resources were changed by this qualification. Two inherited unrelated untracked integration artifacts remain preserved outside this commit.
