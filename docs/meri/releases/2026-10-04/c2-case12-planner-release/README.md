# Case 12 retrospective approval planner release

Merged PR #1950 repairs the native memory plan for “What did we approve about Aster’s autonomous maritime demo?” Selected-client, authorized-entity, ambiguous/compound request, and source-specific request guards remain enforced. The earlier failed capture remains FAILED_BEFORE_ACCEPTANCE and is not retried by this release.

The exact merged source `34e5c37ce1a0d421f008d32cef08dd05e0cc2d7a` passed the source checks and immutable CodeBuild qualification in [release-qualification.json](release-qualification.json). All 27 packaged probes passed, including the compiled native retrospective planner. Hermes reviews are retained with their original conditional findings; root verified the corrective tests rather than relabeling those reviews as unconditional passes.

The fresh baseline is API529, orchestrator123, and Web390. Only the API image and release identity are promoted by the existing release operator. Schema, configuration, schedules and customer model defaults are unchanged. The previous API image remains the rollback candidate. No paid capture or case acceptance is authorized by a healthy deployment alone. Original full acceptance and human answer review remain pending.

Deployment completed as API531 with immutable rollback530. [Served readback](deployed/served-readback.json) verifies exact source/image, all tasks and ALB targets, stopped API529 tasks, ordinary identity and approved-memory list/markdown reads, and ephemeral session revocation. The original Case12 prompt was not rerun by this readback; full acceptance remains open.
