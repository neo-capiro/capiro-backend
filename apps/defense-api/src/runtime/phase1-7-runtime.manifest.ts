export const PHASE17_RUNTIME_MANIFEST = Object.freeze({
  schemaVersion: 1,
  session: 'phase8-session4',
  mode: 'dark-inspect-only',
  sourceOwner: 'retained-api-defense-budget',
  targetOwner: 'defense-api',
  sourceTrees: {
    defenseBudget: {
      source: 'retained-api/defense-budget',
      mirror: 'defense-api/runtime-source/defense-budget',
      gitTreeSha: 'dba0990b9506e4079a9cc44c4892b063f1260d04',
    },
    snapshot: {
      source: 'retained-api/program-element/snapshot',
      mirror: 'defense-api/runtime-source/program-element/snapshot',
      gitTreeSha: '1092e24f909a2c279ac24da57bc144e23826aa76',
    },
    sourceDocument: {
      source: 'retained-api/program-element/source-document',
      mirror: 'defense-api/runtime-source/program-element/source-document',
      gitTreeSha: 'f1aba645832574acbdb713117a1fbdf2ec0ccef3',
    },
    deltas: {
      source: 'retained-api/program-element/deltas',
      mirror: 'defense-api/runtime-source/program-element/deltas',
      gitTreeSha: '66ea14b47d2b311080f73a15f916895a26395878',
    },
  },
  capabilities: [
    'source profiles and immutable source lineage',
    'provider-neutral parser routing',
    'semantic family extraction',
    'Phase 2 verification and review policy',
    'RDT&E, Procurement, O&M and MILCON projection planning',
    'congressional stage composition and Phase 6 certification',
    'Phase 7 eligibility and inspect-only promotion planning',
    'snapshot, delta and outbox status lineage',
    'production-equivalent inspect-only adapters (fixture dual-path)',
  ],
  forbiddenInHttpTask: [
    'canonical promotion execution',
    'active snapshot mutation',
    'migration authority',
    'parser worker process ownership',
    'NVIDIA or GPU runtime',
  ],
  acceptance: {
    sourceTreeParity: 'enforced',
    compileAndUnitTests: 'required-in-ci',
    realFy27Replay: 'required-before-session4-complete',
    productionCutover: false,
  },
} as const);

export type Phase17RuntimeManifest = typeof PHASE17_RUNTIME_MANIFEST;
