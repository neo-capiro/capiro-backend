# Stage 1 exit dashboard

The orchestrator fills evidence links and changes status only after owner review. Tool output alone does not grant approval.

| Exit criterion | Evidence source | Status |
| --- | --- | --- |
| Paired-shadow decision quality is reported for approved labeled tuning rows and independently for held-out rows, for both providers. | Pending: link version/model-scoped Stage 1c JSON and Markdown reports. | pending |
| Material claim-selection recall meets the accepted target without tuning on held-out cases. | Pending: link Stage 1a fixture run and approved target. | pending |
| Exact-source failures (missing, unreadable, metadata-only, no relevant passage, version mismatch, wrong client) are detected correctly. | Pending: link exact-source fixture results and reviewer adjudication. | pending |
| Retrieve-revise-recheck offline replay succeeds within bounded attempts and records terminal reasons. | Pending: link Stage 1d repair replay artifact. | pending |
| Stage 1 causes no user-visible answer blocking, delay, rewriting, or shadow-triggered live retrieval/tool calls. | Pending: link post-release ordering tests, latency evidence, and operational review. | pending |
| A designated human owner approves claim categories and high-risk category treatment. | Pending: link named reviewer, reviewed dataset revision, date, and approval note. | pending |
