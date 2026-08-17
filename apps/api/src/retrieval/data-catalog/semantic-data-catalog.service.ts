import { Injectable } from '@nestjs/common';
import {
  RETRIEVAL_DOMAINS,
  type RetrievalDomain,
  type SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';

const exactEnumerative = {
  exactFiltering: true,
  dateRange: true,
  pagination: true,
  exhaustiveScan: true,
  temporalHistory: false,
} as const;

const livePublic = (
  domain: RetrievalDomain,
  label: string,
  description: string,
  entityKinds: readonly string[],
  supportedQueryClasses: SemanticDatasetDescriptor['supportedQueryClasses'],
  adapterKey: string,
  temporalSemantics = 'authoritative live structured state plus source timestamps',
): SemanticDatasetDescriptor => ({
  domain,
  label,
  description,
  entityKinds,
  sourceKind: 'live_structured',
  authority: 'public_system_of_record',
  tenantScope: 'mixed',
  temporalSemantics,
  supportedQueryClasses,
  queryCapabilities: exactEnumerative,
  adapterKey,
  freshnessDescription: 'Source health and last successful sync must be reported by the domain adapter.',
});

const DATASETS: readonly SemanticDatasetDescriptor[] = [
  {
    domain: 'clients',
    label: 'Clients',
    description: 'Tenant CRM client/account records and durable profile metadata.',
    entityKinds: ['client', 'organization'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'current CRM state with created_at and updated_at',
    supportedQueryClasses: ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'core-prisma',
    freshnessDescription: 'Immediate database state; freshness is the newest evaluated row update time.',
  },
  {
    domain: 'contacts',
    label: 'Contacts',
    description: 'Tenant engagement contacts associated to clients and public-directory identities.',
    entityKinds: ['contact', 'person', 'organization'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'current contact state with created_at and updated_at',
    supportedQueryClasses: ['lookup', 'relationship_history', 'portfolio_scan', 'exhaustive_search', 'comparison'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'core-prisma',
    freshnessDescription: 'Immediate database state; freshness is the newest evaluated row update time.',
  },
  {
    domain: 'mail',
    label: 'Mail',
    description: 'Tenant-authorized mailbox messages and thread/client associations.',
    entityKinds: ['mail_message', 'mail_thread', 'person', 'client'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'message sent/received time plus mailbox sync state',
    supportedQueryClasses: ['lookup', 'entity_history', 'relationship_history', 'change_detection', 'exhaustive_search'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'core-prisma',
    freshnessDescription: 'Mailbox connection last_sync_at plus message timestamps.',
  },
  {
    domain: 'meetings',
    label: 'Meetings and Debriefs',
    description: 'Tenant meetings plus authorized prep/notes/debrief artifact coverage.',
    entityKinds: ['meeting', 'meeting_prep', 'meeting_note', 'meeting_debrief', 'person', 'client'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'meeting interval plus artifact lifecycle timestamps',
    supportedQueryClasses: ['lookup', 'entity_history', 'relationship_history', 'change_detection', 'exhaustive_search'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'core-prisma',
    freshnessDescription: 'Calendar connection last_sync_at plus meeting/artifact timestamps.',
  },
  {
    domain: 'tasks',
    label: 'Tasks',
    description: 'Tenant engagement tasks and their client, meeting, contact, and mail associations.',
    entityKinds: ['task', 'client', 'meeting', 'contact', 'mail_thread'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'current workflow state, due date, created_at and updated_at',
    supportedQueryClasses: ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'core-prisma',
    freshnessDescription: 'Immediate database state.',
  },
  {
    domain: 'action_recommendations',
    label: 'Action Recommendations',
    description: 'Governed recommended actions tied to clients and source evidence.',
    entityKinds: ['action_recommendation', 'client'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'recommendation lifecycle state and timestamps',
    supportedQueryClasses: ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'action-recommendations',
    freshnessDescription: 'Immediate database state.',
  },
  {
    domain: 'outreach',
    label: 'Outreach',
    description: 'Tenant outreach records, drafts, recipients, delivery state, and client associations.',
    entityKinds: ['outreach', 'client', 'person'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'draft/send/delivery lifecycle plus created_at and updated_at',
    supportedQueryClasses: ['lookup', 'entity_history', 'change_detection', 'portfolio_scan', 'exhaustive_search'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'core-prisma',
    freshnessDescription: 'Immediate database state plus provider delivery timestamps where available.',
  },
  {
    domain: 'strategies_work',
    label: 'Strategies and Work',
    description: 'Client strategy/work objects and durable work-product metadata.',
    entityKinds: ['strategy', 'work_item', 'client'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'current strategy/work lifecycle with source timestamps',
    supportedQueryClasses: ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'strategies-work',
    freshnessDescription: 'Reported by the strategy/work domain adapter.',
  },
  livePublic(
    'program_elements',
    'Program Elements',
    'Authoritative defense budget Program Element, year, project, performer, mark, and provenance data.',
    ['program_element', 'program_element_year', 'project', 'performer', 'budget_action'],
    ['lookup', 'entity_history', 'temporal_state', 'change_detection', 'exhaustive_search', 'comparison', 'federal_market_analysis'],
    'program-elements',
    'fiscal-year and budget-stage state with per-source provenance and historical deltas',
  ),
  livePublic(
    'legiwatch_bills',
    'LegiWatch and Bills',
    'Federal/state bill, action, sponsor, vote, version, status, alert, and client-association data.',
    ['bill', 'bill_action', 'vote', 'bill_version', 'legiwatch_alert'],
    ['lookup', 'entity_history', 'temporal_state', 'change_detection', 'exhaustive_search', 'comparison'],
    'legiwatch-bills',
    'procedural event history plus current derived bill status',
  ),
  livePublic(
    'hearings',
    'Hearings',
    'Live and archived hearing/session metadata, transcript artifacts, and alertable mentions.',
    ['hearing', 'hearing_session', 'transcript'],
    ['lookup', 'entity_history', 'change_detection', 'exhaustive_search'],
    'hearings',
  ),
  livePublic(
    'grants',
    'Federal Grants',
    'Authoritative federal grant opportunities and tenant/client nexus metadata.',
    ['grant', 'grant_opportunity'],
    ['lookup', 'temporal_state', 'change_detection', 'exhaustive_search', 'comparison', 'federal_market_analysis'],
    'grants',
  ),
  livePublic(
    'contracts_opportunities',
    'Contracts and Opportunities',
    'Federal procurement solicitations/opportunities and matching metadata.',
    ['contract_opportunity', 'solicitation'],
    ['lookup', 'temporal_state', 'change_detection', 'exhaustive_search', 'comparison', 'federal_market_analysis'],
    'contracts-opportunities',
  ),
  livePublic(
    'federal_awards',
    'Federal Awards',
    'Authoritative federal award/contract history and contractor relationships.',
    ['federal_award', 'contract_award', 'recipient'],
    ['lookup', 'entity_history', 'relationship_history', 'change_detection', 'exhaustive_search', 'comparison', 'federal_market_analysis'],
    'federal-awards',
  ),
  livePublic(
    'directory',
    'Government Directory',
    'Congressional, committee, agency, and defense stakeholder directory records.',
    ['directory_contact', 'office', 'committee', 'agency', 'person'],
    ['lookup', 'relationship_history', 'exhaustive_search', 'comparison'],
    'directory',
    'current authoritative directory state plus source-specific update timestamps',
  ),
  {
    domain: 'district_nexus',
    label: 'District Nexus',
    description: 'Derived client/company/facility/award/grant relationships to congressional districts.',
    entityKinds: ['district', 'facility', 'client', 'grant', 'award', 'member'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'mixed',
    temporalSemantics: 'derived nexus state from current authoritative source rows',
    supportedQueryClasses: ['lookup', 'relationship_history', 'portfolio_scan', 'exhaustive_search', 'comparison', 'federal_market_analysis'],
    queryCapabilities: exactEnumerative,
    adapterKey: 'district-nexus',
    freshnessDescription: 'Freshness is the minimum health/freshness of the source rails used by the nexus.',
  },
  {
    domain: 'institutional_knowledge',
    label: 'Institutional Knowledge',
    description: 'Canonical, provenance-bearing tenant knowledge projected through the Temporal Knowledge Graph.',
    entityKinds: ['canonical_entity', 'knowledge_assertion', 'knowledge_episode', 'relationship'],
    sourceKind: 'knowledge_plane',
    authority: 'knowledge_plane',
    tenantScope: 'mixed',
    temporalSemantics: 'bitemporal valid-time plus observed-time semantics with no hindsight leakage',
    supportedQueryClasses: ['entity_history', 'relationship_history', 'temporal_state', 'change_detection'],
    queryCapabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: false,
      exhaustiveScan: false,
      temporalHistory: true,
    },
    adapterKey: 'knowledge-plane-temporal-graph',
    freshnessDescription: 'Derived from authoritative KnowledgeEvent/Assertion/Evidence observation timestamps.',
  },
] as const;

@Injectable()
export class SemanticDataCatalogService {
  private readonly byDomain = new Map<RetrievalDomain, SemanticDatasetDescriptor>(
    DATASETS.map((dataset) => [dataset.domain, dataset]),
  );

  constructor() {
    const missing = RETRIEVAL_DOMAINS.filter((domain) => !this.byDomain.has(domain));
    if (missing.length > 0 || this.byDomain.size !== RETRIEVAL_DOMAINS.length) {
      throw new Error(`Semantic Data Catalog domain mismatch; missing=${missing.join(',')}`);
    }
  }

  list(): readonly SemanticDatasetDescriptor[] {
    return DATASETS;
  }

  get(domain: RetrievalDomain): SemanticDatasetDescriptor {
    const dataset = this.byDomain.get(domain);
    if (!dataset) throw new Error(`Unknown Retrieval V2 domain: ${domain}`);
    return dataset;
  }
}
