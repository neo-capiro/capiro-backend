BLOCKED

Concrete bug: source-specific approval questions can be misrouted to memory-only recall.

In `evidence/meri-context-plane.service.ts`, `isRetrospectiveApprovalRecall` excludes a limited list of source words (lines 1268–1271), and the new memory-only branch runs before `taskDomains` (lines 541–552, 603–620). The exclusion list catches “document” and email terms, but misses ordinary document/source references such as “proposal,” “contract,” “PDF,” “report,” and meeting sources such as “transcript” or “call.” For example:

`What did we approve about Aster’s autonomous maritime demo in the proposal?`

The retrospective-approval predicate still matches; the possessive extractor accepts the longer subject phrase; unique authorized `Aster` shorthand resolves to the selected Aster Defense client; and the planner returns only `institutional_knowledge`. Thus it never routes to a document-capable source or the normal client-analysis plan. The bundled regression test covers “in the document,” but not these common source terms. Add source-qualified negatives (including meeting-source wording) and ensure they cannot take the early memory-only branch.

The reviewed change otherwise keeps the capture guard unchanged, uses the existing selected-client/authorized-unique-prefix check, and adds cases for another client, ambiguity, mail/document wording, approval-as-action, and multi-sentence input. The corrected Phase 19 contract assertions follow the governed variable and extracted eligibility helper while retaining the canonical SQL and post-filter guard checks.

Evidence limits: this is a source review of the bundled diff/code and build scripts only. No commands, tests, repository actions, or cloud actions were run. The supplied root test/typecheck results are treated as reported evidence, not independently reproduced. The ARM CodeBuild scripts include exact-SHA/architecture gates, an ARM64 image build, and an offline probe against the compiled planner, but no build or C2 acceptance is claimed.