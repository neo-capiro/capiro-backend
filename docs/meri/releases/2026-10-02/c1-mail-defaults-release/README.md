# C1 mailbox-list release — served and verified, concise warning still open

The user approved the exact prepared mailbox-defaults manifest with “Approved”. [Approval](owner-mail-defaults-approval.json) and [canonical promotion](orchestrator-mail-defaults-promotion.json) bind source `c8e2b8fbfe921fd43a1bd1d4d744a26db138e985`, image `sha256:27418fb841c03bc1637949c45d9deda1d4de8fd5be423d05beaf83e5d1025be6`, and manifest `991d367383b418a7a91a0d1d1c005652d29a96a3ca1ce933cff916319c3db211`. Orchestrator109 is healthy. Rollback108 pins the previous107 image. [Fresh readback](mail-defaults-final-service-readback.json) verifies the running source, image, configuration and actual target health through the canonical operator; API515 and WebVNext388 baseline fingerprints are unchanged. Retain the already-applied forward452 index on application rollback.

## Served behavior

| Check | Result | Server request duration |
| --- | --- | ---: |
| Minimal `list_emails` prompt with only `limit:1` | PASS: returned 1, totalMatches30,002, hasMoretrue; correct sync and pagination limits | 16.352 s |
| Literal-zero mail search | PASS: healthy 0; actual sync limits, no contradictory footer | 13.691 s |
| Known mail search,365days/limit1 | PASS: returned 1, totalMatches29,990, hasMoretrue; truthful pagination/sync limits | 10.794 s |
| Own open-task count | PASS:0, one native task read, no unrelated disclaimer or legislative call | 7.658 s |
| Three-bullet capability answer with “Use no tools” | FAIL: correct3 bullets and0 tools, but an unrelated source-never-called coverage footer | 3.399 s |
| Reload | PASS: all 5 new answers persisted;13 total answer pairs in the thread | — |

[Browser outcomes](browser-mail-defaults-final.json) and [92 joined telemetry events](mail-defaults-final-telemetry.json) retain the actual results. Tool-owner spans were list 1,791ms, zero-search 910ms, known-search 1,267ms and task 22ms. The precise prompt constrains the model's list arguments; the browser did not independently capture serialized request arguments. The packaged source qualification separately proves minimal-input default normalization. Model `gpt-6-astra`, Standard mode and medium effort were retained. No business writes or memory decisions were performed.

The minimal-list first-useful and terminal state were observed together at 27,046ms. A cross-call observer-closure error initially associated the second case with the first record; that capture error is retained, its incorrect timing is not accepted, and the zero-search UI elapsed time remains unavailable. Later helpers explicitly pass case objects: known-search first/terminal10,912/10,942ms, task 7,769/7,794ms, concise 3,651/3,669ms. Server spans use exact shared run/trace/request/turn IDs; browser-case labels correlate by serial order and matching tools/counts. None of these measurements is first-token latency or p95, and browser/server clock offsets are not assumed. [Local screenshot identities](screenshots.json) retain two initially misframed captures as rejected evidence: both showed the earlier explicit-defaults diagnostic. Two replacement captures were visually verified to show the109minimal mailbox prompt/result and exact concise-warning failure. The JSON/telemetry outcomes were unaffected.

## Remaining C1 work

The exact concise prompt reproduces a classifier false positive: “Use no tools” is an execution constraint, not a claim that an external source contains no records. Repair that classification narrowly, retain genuine negative/exhaustive and partial/failed-source warnings, qualify the resulting immutable image, then verify the exact concise case and affected coverage through the served workspace. C1 remains incomplete.

The existing isolated [known/zero task and controlled mail-failure/recovery evidence](../c1-post-release/README.md) remains valid at its stated boundaries. The [original503 investigation](../c1-classification-repair/mail-incident.json) retains count-query I/O/deadline evidence and its correlation limits. No fixture was rerun for this release. Historical failures, original75/CD/CW acceptance, frozen-clock limitations and older unknown spend remain unchanged. C0 is complete; File01 is not ready for File02.
