import { ConfigService } from '@nestjs/config';
import { MeriV3SemanticRuntimeStore } from './meriv3-semantic-runtime.store.js';

export interface MeriSemanticCompatibilitySchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type MeriSemanticCompatibilityToolName = 'analyze_funding_opportunity' | 'create_artifact';

export type MeriSemanticToolInvoker = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

const FUNDING_REASONING_TOOLS = new Set([
  'explain_opportunity_match',
  'get_opportunity_client_context',
  'get_opportunity_government_landscape',
  'compare_funding_opportunities',
  'build_opportunity_action_plan',
]);

const LEGACY_ARTIFACT_TOOLS = new Set([
  'create_word',
  'create_excel',
  'create_powerpoint',
  'create_meeting_brief',
  'draft_policy_memo',
]);

const ARTIFACT_TOOL_BY_TYPE: Record<string, string> = {
  word: 'create_word',
  pdf: 'create_word',
  spreadsheet: 'create_excel',
  presentation: 'create_powerpoint',
  meeting_brief: 'create_meeting_brief',
  policy_memo: 'draft_policy_memo',
};

const CLIENT_AWARE_ARTIFACT_TYPES = new Set([
  'word',
  'pdf',
  'spreadsheet',
  'presentation',
  'policy_memo',
]);

const ANALYZE_FUNDING_OPPORTUNITY_SCHEMA: MeriSemanticCompatibilitySchema = {
  name: 'analyze_funding_opportunity',
  description:
    'Retrieve one federal funding opportunity as a structured evidence packet for OpenAI to analyze. Returns the local opportunity facts, deterministic match evidence, client context, government landscape, freshness and coverage. It does not compare opportunities, rank pursuits, recommend a strategy, or build an action plan; perform that reasoning from the returned evidence. Requires clientId, source (grants_gov or sam_gov), and sourceRecordId.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      clientId: {
        type: 'string',
        description: 'Authorized Capiro client UUID used for tenant-wall and fit evidence.',
      },
      source: {
        type: 'string',
        enum: ['grants_gov', 'sam_gov'],
        description: 'Canonical opportunity source.',
      },
      sourceRecordId: {
        type: 'string',
        description: 'The source-native notice or opportunity identifier stored by Capiro.',
      },
    },
    required: ['clientId', 'source', 'sourceRecordId'],
  },
};

const CREATE_ARTIFACT_SCHEMA: MeriSemanticCompatibilitySchema = {
  name: 'create_artifact',
  description:
    'Generate and persist one governed Capiro artifact through the existing document services. OpenAI owns the reasoning and writing; Capiro owns generation, formatting, storage, versions, provenance, approvals and export. Put clientId and conversationId at the TOP LEVEL, not inside `spec`; Meri pins both to the active conversation when applicable. `spec` is the structured input accepted by the backing artifact type: Word and PDF use title/subtitle/sections with paragraphs, bullets and tables, and support both Word and PDF downloads from the same saved content; spreadsheet uses sheets with headers and rows; presentation uses a title slide and content slides; meeting_brief uses meetingId/title; policy_memo uses title/objective/body. This gateway never bypasses the underlying write/compliance gate.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['word', 'pdf', 'spreadsheet', 'presentation', 'meeting_brief', 'policy_memo'],
      },
      clientId: {
        type: 'string',
        description:
          'Authorized Capiro client UUID. Required for policy_memo; optional for generated Word, PDF, spreadsheet and presentation artifacts.',
      },
      conversationId: {
        type: 'string',
        description:
          'Current Meri conversation id. Supplied automatically when the turn belongs to a conversation.',
      },
      spec: {
        type: 'object',
        description:
          'Complete structured content for the selected artifact type. Do not put clientId or conversationId inside this object.',
        additionalProperties: true,
      },
    },
    required: ['type', 'spec'],
  },
};

function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Transitional semantic wrappers over existing governed tools.
 *
 * No backend implementation is deleted. When a wrapper flag is on for an
 * allowlisted tenant, redundant model-facing reasoning/tool schemas are hidden
 * and the wrapper delegates to the same authorized services underneath.
 */
export class MeriV3SemanticCompatibilityTools {
  constructor(private readonly config: ConfigService) {}

  prepareSchemas(
    schemas: MeriSemanticCompatibilitySchema[],
    tenantId: string,
  ): MeriSemanticCompatibilitySchema[] {
    const researchDirectorCanonical = this.researchDirectorCanonicalEnabled(tenantId);
    const quickCompanyProfile =
      MeriV3SemanticRuntimeStore.current()?.plan.reasons.includes('quick-company-profile') === true;
    const fundingEnabled = this.fundingEnabled(tenantId);
    const artifactEnabled = this.artifactEnabled(tenantId);
    const filtered = schemas.filter((schema) => {
      if (
        researchDirectorCanonical &&
        !quickCompanyProfile &&
        schema.name === 'research_external_company'
      ) {
        return false;
      }
      if (fundingEnabled && FUNDING_REASONING_TOOLS.has(schema.name)) return false;
      if (artifactEnabled && LEGACY_ARTIFACT_TOOLS.has(schema.name)) return false;
      return true;
    });
    if (fundingEnabled) filtered.push(ANALYZE_FUNDING_OPPORTUNITY_SCHEMA);
    if (artifactEnabled) filtered.push(CREATE_ARTIFACT_SCHEMA);
    return filtered;
  }

  isEnabledTool(name: string, tenantId: string): name is MeriSemanticCompatibilityToolName {
    return (
      (name === 'analyze_funding_opportunity' && this.fundingEnabled(tenantId)) ||
      (name === 'create_artifact' && this.artifactEnabled(tenantId))
    );
  }

  async execute(
    name: MeriSemanticCompatibilityToolName,
    input: Record<string, unknown>,
    invoke: MeriSemanticToolInvoker,
  ): Promise<unknown> {
    if (name === 'analyze_funding_opportunity') {
      return this.analyzeFundingOpportunity(input, invoke);
    }
    return this.createArtifact(input, invoke);
  }

  fundingEnabled(tenantId: string): boolean {
    return this.featureEnabled(
      'MERI_FUNDING_SEMANTIC_TOOLS_ENABLED',
      'MERI_FUNDING_SEMANTIC_TOOLS_TENANTS',
      tenantId,
    );
  }

  artifactEnabled(tenantId: string): boolean {
    return this.featureEnabled(
      'MERI_ARTIFACT_TOOL_V2_ENABLED',
      'MERI_ARTIFACT_TOOL_V2_TENANTS',
      tenantId,
    );
  }

  private researchDirectorCanonicalEnabled(tenantId: string): boolean {
    return this.featureEnabled(
      'MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED',
      'MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS',
      tenantId,
    );
  }

  private async analyzeFundingOpportunity(
    input: Record<string, unknown>,
    invoke: MeriSemanticToolInvoker,
  ): Promise<unknown> {
    const clientId = typeof input.clientId === 'string' ? input.clientId : '';
    const source = typeof input.source === 'string' ? input.source : '';
    const sourceRecordId = typeof input.sourceRecordId === 'string' ? input.sourceRecordId : '';
    const opportunityInput = { clientId, source, sourceRecordId };

    const opportunity = await invoke('get_funding_opportunity', opportunityInput);
    const clientEvidence = await invoke('get_opportunity_client_context', { clientId });
    const matchEvidence = await invoke('explain_opportunity_match', opportunityInput);
    const governmentLandscape = await invoke(
      'get_opportunity_government_landscape',
      opportunityInput,
    );
    const requirements =
      source === 'sam_gov'
        ? await invoke('get_funding_opportunity_requirements', opportunityInput)
        : {
            state: 'notice_body',
            explanation:
              'Read Grants.gov notice terms in opportunity.data.summary and continue summaryRead.nextOffset when present.',
          };

    return {
      kind: 'funding_opportunity_evidence',
      analysisOwner: 'openai',
      opportunity,
      clientEvidence,
      matchEvidence,
      governmentLandscape,
      requirements,
      coverage: {
        requestedDomains: [
          'opportunity_facts',
          'client_evidence',
          'match_evidence',
          'government_landscape',
          'mandatory_conditions',
        ],
        toolsInvoked: [
          'get_funding_opportunity',
          'get_opportunity_client_context',
          'explain_opportunity_match',
          'get_opportunity_government_landscape',
          ...(source === 'sam_gov' ? ['get_funding_opportunity_requirements'] : []),
        ],
      },
    };
  }

  private createArtifact(
    input: Record<string, unknown>,
    invoke: MeriSemanticToolInvoker,
  ): Promise<unknown> {
    const type = typeof input.type === 'string' ? input.type : '';
    const backingTool = ARTIFACT_TOOL_BY_TYPE[type];
    if (!backingTool) {
      return Promise.resolve({
        error: 'Unsupported artifact type',
        supportedTypes: Object.keys(ARTIFACT_TOOL_BY_TYPE),
      });
    }

    const spec = { ...asRecord(input.spec) };
    const topLevelClientId = optionalTrimmedString(input.clientId);
    const nestedClientId = optionalTrimmedString(spec.clientId);
    if (topLevelClientId && nestedClientId && topLevelClientId !== nestedClientId) {
      return Promise.resolve({
        blocked: true,
        error:
          'The artifact spec attempted to change the client pinned to this conversation. Nothing was created.',
      });
    }

    const topLevelConversationId = optionalTrimmedString(input.conversationId);
    const nestedConversationId = optionalTrimmedString(spec.conversationId);
    if (
      topLevelConversationId &&
      nestedConversationId &&
      topLevelConversationId !== nestedConversationId
    ) {
      return Promise.resolve({
        blocked: true,
        error:
          'The artifact spec attempted to change the active conversation. Nothing was created.',
      });
    }

    const clientId = topLevelClientId ?? nestedClientId;
    const conversationId = topLevelConversationId ?? nestedConversationId;
    delete spec.clientId;
    delete spec.conversationId;

    if (type === 'policy_memo' && !clientId) {
      return Promise.resolve({
        error: 'policy_memo requires an authorized clientId.',
      });
    }
    if (clientId && CLIENT_AWARE_ARTIFACT_TYPES.has(type)) spec.clientId = clientId;
    if (conversationId) spec.conversationId = conversationId;
    if (type === 'pdf') spec.format = 'pdf';

    return invoke(backingTool, spec);
  }

  private featureEnabled(flag: string, tenantFlag: string, tenantId: string): boolean {
    if (this.config.get<string>(flag)?.trim().toLowerCase() !== 'true') return false;
    const configured =
      this.config.get<string>(tenantFlag) ??
      this.config.get<string>('MERI_SEMANTIC_TOOL_GATEWAY_TENANTS');
    const allowed = parseAllowlist(configured);
    const normalized = tenantId.trim().toLowerCase();
    return allowed.has('*') || allowed.has(normalized);
  }
}
