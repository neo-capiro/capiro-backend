# Unused research schedule wrapper cleanup

The private `@capiro/meriv2-orchestrator` application exported
`researchScheduleConstraints` and `validateResearchScheduleDraft` from
`meri-research-director.ts`. Both delegated directly to `@capiro/shared`
schedule helpers, but neither was called or registered.

Before removal, Graphy indexed `apps/meriv2-orchestrator/src/meri` (219 files,
9,624 nodes) and reported both functions as potentially unused with zero
affected symbols in its impact analysis. A repository-wide exact-name search
found only their definitions. Imports of `meri-research-director.js` were
inspected; consumers import other named exports. The package is marked
`private: true` and declares no published exports. The shared schedule helpers
remain available to active code.

No tests, typecheck, or build were run because the user paused those checks for
machine resource headroom. This removal is source-reviewed only until the
integrated candidate is qualified.
