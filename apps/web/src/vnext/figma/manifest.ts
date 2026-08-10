export const CAPIRO_FIGMA = {
  productFile: {
    fileKey: '2aa9ipR2qOfumaixZErCfU',
    name: 'Capiro Design System v3 — Premium Intelligence Platform',
  },
  vendorFile: {
    fileKey: '6NmsN8HSqbwJ0VjJvTYDtR',
    name: 'Untitled UI v8 — Vendor Source',
  },
  appShell: {
    page: '721:2502',
    expanded: '722:2502',
    collapsed: '723:2530',
    interactions: '725:2560',
  },
  dashboard: {
    page: '748:2502',
    expanded: '751:2502',
    collapsed: '753:2532',
  },
  programElements: {
    page: '768:2502',
    explore: '773:2956',
    movement: '775:2532',
    congressional: '776:2545',
    actions: '777:2558',
    portfolio: '778:2603',
    profileOverview: '780:2644',
    fundingLifecycle: '782:2663',
    legislative: '783:2679',
    programStructure: '784:2701',
    sourcesProof: '785:2717',
    implementationHandoff: '788:2765',
  },
} as const;

export const FIGMA_REACT_MAPPING_INVENTORY = [
  { figma: 'Button/Main', react: 'CapiroButton', source: 'vnext/components/actions' },
  { figma: 'Shell/MeriLauncher', react: 'MeriLauncher', source: 'vnext/shell/MeriLauncher' },
  { figma: 'Shell/Search', react: 'GlobalSearch', source: 'vnext/shell/GlobalSearch' },
  { figma: 'Mailbox Sync', react: 'MailboxSyncStatus', source: 'vnext/shell/MailboxSyncStatus' },
  { figma: 'Status/Badge', react: 'CapiroBadge', source: 'vnext/components/badges' },
  { figma: 'Funding trajectory', react: 'FundingTrajectory', source: 'vnext/intelligence/FundingTrajectory' },
  { figma: 'Request → current bridge', react: 'FundingBridge', source: 'vnext/intelligence/FundingBridge' },
  { figma: 'Congressional path', react: 'CongressionalPath', source: 'vnext/intelligence/CongressionalPath' },
  { figma: 'Evidence coverage', react: 'EvidenceCoverage', source: 'vnext/intelligence/EvidenceCoverage' },
  { figma: 'Movement rail', react: 'MovementRail', source: 'vnext/intelligence/MovementRail' },
  { figma: 'Movement distribution', react: 'MovementDistribution', source: 'vnext/intelligence/MovementDistribution' },
  { figma: 'Program relationship map', react: 'ProgramRelationshipMap', source: 'vnext/intelligence/ProgramRelationshipMap' },
] as const;
