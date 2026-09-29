# Narrative source-integrity integration

Integration base: f766e859e16fa7d16802c0487030063ff9ddb6c6. Reviewed donor: c9f7ae3d27f0d9e3a5d5eeaf3a9582f4d25b2052, apps/packages patch relative to 2e7b8e66f. Kimi independently reran the original 23-case source-integrity probe with exit 0 and closed the three scoped findings: canonical document projection losing owner identity, summary-only intel being treated as consulted, and explicit ownerVerified false being lost. Probe outputs are in narrative-c9f-independent-original-probes.log; scoped review is review-narrative-c9f7-report.md under C:/dev/cap-meri-foundation-evidence.

The combined repair binds passages to exact owner rows/spans, preserves owner and acquisition metadata, and prevents discovery summaries or unrelated serialized results from supplying consulted evidence. This affects shared/core evidence contracts and orchestrator citation/JEV repair across source families. No production provider, model, routing or access cohort changes are included.

One assistant-service conflict was combined explicitly: the new budgeted repair registry receives the existing current-procedure-authority callback and admitted read capabilities. Its existing wrapper retains capability checks, aggregate budget accounting, procedure dispatch checks, before-invoke authorization and logical-result observation. The source donor alone did not carry these newer integration gates. Original source patch is preserved as narrative-reviewed-integration.patch.

PASS, combined local qualification: 183 core tests in 3 suites and 225 runtime tests in 6 suites (408 total); shared/core builds; API and orchestrator typechecks; 24-file Prettier and git diff checks, all actual exit 0. Formatting after tests changed whitespace only. Evidence: narrative-combined-gates.json, narrative-combined-final-gates.json and corresponding full logs. This does not represent live provider, shared-database or complete File01 acceptance.

Both-main integration, hosted release gates, full synthetic acceptance and named owner release approval remain pending. No main merge, deployment or synthetic cohort enablement occurred.
