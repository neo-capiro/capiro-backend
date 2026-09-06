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
  queryCapabilities: SemanticDatasetDescriptor['queryCapabilities'] = exactEnumerative,
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
  queryCapabilities,
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
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
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
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
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
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
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
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
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
    supportedQueryClasses: ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison'],
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
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
    supportedQueryClasses: ['lookup', 'entity_history', 'relationship_history', 'change_detection', 'portfolio_scan', 'exhaustive_search'],
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
    adapterKey: 'core-prisma',
    freshnessDescription: 'Immediate database state plus provider delivery timestamps where available.',
  },
  {
    domain: 'strategies_work',
    label: 'Strategies and Work',
    description: 'Authorized active client strategies, nodes, source-anchored context facts, documents and unresolved conflicts.',
    entityKinds: ['strategy', 'work_item', 'client'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'tenant_private',
    temporalSemantics: 'current strategy/work lifecycle with source timestamps',
    supportedQueryClasses: ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison'],
    queryCapabilities: { ...exactEnumerative, exactFiltering: false },
    adapterKey: 'strategies-work',
    freshnessDescription: 'Reported by the strategy/work domain adapter.',
  },
  livePublic(
    'program_elements', 'Program Elements',
    'Ingested current Program Element catalog and funding-claim summaries; no full historical-stage reconstruction.',
    ['program_element', 'funding_claim'],
    ['lookup', 'comparison', 'exhaustive_search', 'federal_market_analysis'],
    'public-domain-services', 'current ingested catalog state with fiscal-year and stage evidence carried in source summaries',
    { exactFiltering: true, dateRange: false, pagination: true, exhaustiveScan: true, temporalHistory: false },
  ),
  livePublic(
    'legiwatch_bills', 'LegiWatch and Bills',
    'Current ingested federal and state bill summaries, including latest-action dates. Complete action/version histories are not supplied.',
    ['bill'], ['lookup', 'comparison', 'exhaustive_search'],
    'public-domain-services', 'current bill state; date windows filter latest action date',
    { exactFiltering: true, dateRange: true, pagination: true, exhaustiveScan: true, temporalHistory: false },
  ),
  livePublic(
    'hearings', 'Hearings',
    'Public hearing events, pageable official transcript text, finalized canonical machine transcript segments, source-linked intelligence and authorized client relevance. Encrypted legacy browser-session data is a separate unsupported rail; coverage is reported as partial.',
    ['hearing', 'official_transcript_chunk', 'machine_transcript_segment', 'hearing_intelligence', 'client_hearing_relevance'],
    ['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison'],
    'hearings', 'event instants where known; date-only official transcripts retain day precision; change detection filters record observation/update time',
    { exactFiltering: false, dateRange: true, pagination: true, exhaustiveScan: false, temporalHistory: false },
  ),
  livePublic(
    'grants', 'Federal Grants',
    'Existing funding-service grant listings with authorized client matching. Upstream scan limits, missing source data and pagination are preserved.',
    ['grant_opportunity'], ['lookup', 'comparison', 'exhaustive_search', 'federal_market_analysis'],
    'public-domain-services', 'current opportunity state; date windows filter response deadlines',
    { exactFiltering: false, dateRange: true, pagination: true, exhaustiveScan: false, temporalHistory: false },
  ),
  livePublic(
    'contracts_opportunities', 'Contracts and Opportunities',
    'Existing procurement-opportunity listings and authorized client matching, with source scan limits reported explicitly.',
    ['contract_opportunity', 'solicitation'], ['lookup', 'comparison', 'exhaustive_search', 'federal_market_analysis'],
    'public-domain-services', 'current opportunity state; date windows filter response deadlines',
    { exactFiltering: true, dateRange: true, pagination: true, exhaustiveScan: false, temporalHistory: false },
  ),
  livePublic(
    'federal_awards', 'Federal Awards',
    'Ingested Federal Market contract-award summaries and authorized client filtering, with source timestamps and completeness reported.',
    ['federal_award', 'contract_award'], ['lookup', 'comparison', 'exhaustive_search', 'federal_market_analysis'],
    'public-domain-services', 'current ingested award records; date windows filter action dates',
    { exactFiltering: true, dateRange: true, pagination: true, exhaustiveScan: true, temporalHistory: false },
  ),
  livePublic(
    'directory', 'Government Directory',
    'Existing congressional member/staff directory reads. Broader agency/defense coverage and unknown source freshness remain explicit partial coverage.',
    ['directory_contact', 'person'], ['lookup', 'comparison', 'exhaustive_search'],
    'public-domain-services', 'current congressional directory state; historical relationships are not supplied',
    { exactFiltering: false, dateRange: false, pagination: true, exhaustiveScan: true, temporalHistory: false },
  ),
  {
    domain: 'district_nexus',
    label: 'District Nexus',
    description: 'Authorized current client footprint, strategic relevance, economic context and priority-intelligence snapshots from the existing Nexus services. Child entitlements, source warnings and detail caps are preserved.',
    entityKinds: ['district', 'facility', 'client', 'grant', 'award', 'member'],
    sourceKind: 'live_structured',
    authority: 'tenant_system_of_record',
    tenantScope: 'mixed',
    temporalSemantics: 'current client service snapshots; source dates retain their original meaning',
    supportedQueryClasses: ['lookup', 'portfolio_scan', 'comparison', 'federal_market_analysis'],
    queryCapabilities: { exactFiltering: false, dateRange: false, pagination: true, exhaustiveScan: false, temporalHistory: false },
    adapterKey: 'district-nexus',
    freshnessDescription: 'Minimum known sync time of underlying footprint rails. Missing/stale/failed/disabled rails and source detail limits remain in each snapshot.',
  },
  {
    domain: 'institutional_knowledge',
    label: 'Institutional Knowledge',
    description: 'Canonical provenance-bearing tenant knowledge plus governed durable memory, exposed through the shared Knowledge Plane.',
    entityKinds: ['canonical_entity', 'knowledge_assertion', 'knowledge_episode', 'relationship', 'governed_memory'],
    sourceKind: 'knowledge_plane',
    authority: 'knowledge_plane',
    tenantScope: 'mixed',
    temporalSemantics: 'bitemporal graph history plus current governed memory state; revoked/superseded memory is suppressed',
    supportedQueryClasses: ['lookup', 'semantic_recall', 'entity_history', 'relationship_history', 'temporal_state', 'change_detection'],
    queryCapabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: true,
      exhaustiveScan: false,
      temporalHistory: true,
    },
    adapterKey: 'knowledge-plane-temporal-graph',
    freshnessDescription: 'Graph rows use KnowledgeEvent/Assertion/Evidence observation time; governed memories use their durable update/confirmation state.',
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
