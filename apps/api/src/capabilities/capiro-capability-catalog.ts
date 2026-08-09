export type CapabilityCatalogStatus = 'contract_only' | 'implemented' | 'existing_adapter';

export interface CapabilityCatalogEntry {
  name: string;
  status: CapabilityCatalogStatus;
  domainOwner: string;
  inputSchema: string;
  outputSchema: string;
  authorizationBoundary: string;
  supportsClientScope: boolean;
  clientScopeBehavior: string;
  ethicalWallBehavior: string;
  provenanceBehavior: string;
  freshnessBehavior: string;
  sensitivityBehavior: string;
  errorTaxonomy: string;
  meriConsumer: boolean;
  outreachConsumer: boolean;
}

export const CAPIRO_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = ([
  ['search_capiro', 'contract_only', 'search'],
  ['get_capiro_record', 'implemented', 'capabilities/records'],
  ['get_client_context', 'implemented', 'capabilities/clients'],
  ['search_memory', 'contract_only', 'memory'],
  ['research_government', 'contract_only', 'government-research'],
  ['analyze_relationships', 'implemented', 'capabilities/targets'],
  ['analyze_target_coverage', 'implemented', 'capabilities/targets'],
  ['find_similar_targets', 'implemented', 'capabilities/targets'],
  ['get_recent_activity', 'implemented', 'capabilities/activity'],
  ['search_targets', 'implemented', 'capabilities/targets'],
  ['get_target_profile', 'implemented', 'capabilities/targets'],
] as readonly [string, CapabilityCatalogStatus, string][]).map(([name, status, domainOwner]) => ({
  name,
  status: status as CapabilityCatalogStatus,
  domainOwner,
  inputSchema: `${name}.input.v1`,
  outputSchema: `${name}.output.v1`,
  authorizationBoundary: 'server-established tenant plus per-record reauthorization',
  supportsClientScope: true,
  clientScopeBehavior: 'explicit or server-established scope; mismatches fail closed',
  ethicalWallBehavior: 'client access is rechecked; excluded identity is not disclosed',
  provenanceBehavior: 'structured record provenance required for factual results',
  freshnessBehavior: 'asOf and degraded reasons are always present',
  sensitivityBehavior: 'bounded fields; no unrestricted memory, note, transcript, or message bodies',
  errorTaxonomy: 'capiro-capability-errors-v1',
  meriConsumer: true,
  outreachConsumer: true,
}));
