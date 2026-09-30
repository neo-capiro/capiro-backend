# Prior research attachment integrity qualification

Foundation base d27945ed7080f56337361566fb084fadb5821008; source donor c8021497c6bec1cd5494bfe44f0a754be1747112.

Prior research evidence now returns current canonical attachment text only after its SHA256 matches the captured digest. Changing snapshot text alone cannot inject unchecked text. Current attachment kind/status and source-message ownership are checked; session, client wall, and originating conversation authorization are rechecked after the attachment read.

PASS: shared/core builds, 20 targeted attachment tests, API typechecking, changed-file formatting, and git diff check all exited 0 on the combined foundation tree. Independent Hermes/Kimi executed 20 donor tests with exit 0 and separately reviewed the entire foundation-to-donor semantic delta. Initial missing compiler path and stale shared/core output were setup failures, resolved before the accepted runs.

Included CI capacity change: memory-governance repository typechecking uses a step-local 6GB heap and serial Turbo concurrency. Its predecessor completed full API migration replay before API typechecking exhausted 4GB. Independent static review PASS; fresh hosted resource qualification pending. No gates or package targets removed.

Evidence: C:/dev/cap-meri-foundation-evidence/attachment-integrated-gates.json, attachment-integrated-tests.log, review-prior-attachment-binding-report.md, review-attachment-full-integration-report.md, review-memory-capacity-report.md.

Remaining source-family replay work is a separate candidate, not included here. Full File01 acceptance, deployed behavior, database mutation and production canaries are NOT RUN by this change. No main merge, deployment, or routing change performed.
