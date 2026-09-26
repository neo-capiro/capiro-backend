# Research Portfolios Phase 11 qualification record

## Verdict

**NO-GO for production release.** This directory is a local, source-level qualification packet for Research Portfolios phases 9–11. It does not claim that an image was built, a migration was rehearsed or applied, a release was deployed, a feature flag was enabled, a source family was qualified, a notification was sent, or a real customer cohort accepted the product.

The packet closes the documentation and reproducibility portion of Phase 11 only:

- [Requirement and screen register](./requirements-and-screens.md) covers RP-01–RP-10, DI-01–DI-11, MX-01–MX-03, OP-01–OP-04, and S01–S18.
- [Acceptance results](./acceptance-results.md) records AT-01–AT-24 and every section 14.2 probe. All target-environment scenarios remain `NOT RUN` or `BLOCKED`.
- [Release controls](./release-controls.md) defines the empty release cohort, disabled activation posture, bounded limits, evidence that must be captured, and rollback preconditions.
- `scripts/verify-research-portfolios-phases9-11.mjs` checks that this record is complete and that the local Phase 9 source seams exist. A successful verifier run means the packet is internally consistent; it is not a release approval.

## Local baseline

- Baseline commit: `0fe6aba04bb8103d67f7b12dd4ea158bcf592b1f`
- Working branch at packet creation: `agent/research-portfolios-phase9-11`
- Qualification environment: local Windows checkout with an intentionally dirty implementation worktree
- Production account/region/task definitions/images/digests: **NOT INSPECTED**
- Database migration ledger and production role behavior: **NOT INSPECTED**
- Real-family corpus denominators and independent labels: **NOT INSPECTED**
- Customer cohort and operator acceptance: **NONE / NOT RUN**

The baseline SHA identifies the starting commit, not the completed implementation. The eventual merge commit and any release image digest must be added by release operations after the implementation is committed and built.

## Reproduce the local packet check

```text
pnpm verify:research-portfolios-phases9-11
```

Expected result: the command reports `LOCAL QUALIFICATION PACKET: PASS` followed by `RELEASE VERDICT: NO-GO`. A non-zero exit means the packet is incomplete or a required local Phase 9 source seam disappeared.

## Evidence rules

1. A local unit test or source-contract check may support an implementation claim, but never substitutes for tenant-isolation, database-role, browser, image, deployment, or real-corpus evidence.
2. Every future `PASS` in the acceptance table must name the exact environment, source SHA, image digest where applicable, dataset/cohort, command or method, artifact path, and failure disposition.
3. A rejected or unstarted workflow is `NOT RUN`, not a failing or passing test.
4. Existing Package 8/9 records are historical evidence for their named revisions only. They do not establish current Research Portfolio deployment or source qualification.
5. No source/publication/provider switch may be enabled from this packet. Activation requires an independently authorized release operation.

