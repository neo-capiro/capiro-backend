import { ConfigService } from '@nestjs/config';
import { MeriV3SemanticRuntimeStore } from './meriv3-semantic-runtime.store.js';

export interface MeriSemanticCompatibilitySchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type MeriSemanticCompatibilityToolName = 'analyze_funding_opportunity' | 'create_artifact';

export interface MeriSemanticCompatibilityContract {
  /** Descriptive metadata only; it does not authorize, execute, or validate a call. */
  readonly contractRole: 'advisory_only';
  readonly purpose: string;
  readonly exclusions: readonly string[];
  readonly requiredInputs: readonly string[];
  readonly supportedScopes: readonly string[];
  readonly evidenceAuthority: readonly string[];
  readonly dependencies: readonly string[];
  readonly effectClass: 'read_only_evidence' | 'artifact_write';
  readonly availability: {
    readonly featureFlag: string;
    readonly tenantAllowlistFlag: string;
    readonly tenantAllowlistFallbackFlag: string;
    readonly defaultOff: true;
  };
  readonly typeMappings?: readonly {
    readonly type: string;
    readonly handler: string;
    readonly requiredBackingInputs: readonly string[];
    readonly result: string;
  }[];
}

export type MeriSemanticToolInvoker = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

const FUNDING_REASONING_TOOLS = new Set([
  'explain_opportunity_match',
  'get_opportunity_government_landscape',
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
    'Gather evidence for one locally held Grants.gov or SAM.gov opportunity and one authorized client. Returns separate opportunity facts, broader client context, match explanation, government-landscape result, requirements guidance or records, and coverage. Government landscape is composed for SAM.gov; for Grants.gov its result says the source is unsupported. SAM.gov calls the extracted-requirements reader; Grants.gov terms remain in the held notice body in opportunity.data.summary, which may require continuing summaryRead.nextOffset. The packet preserves each underlying result and its availability/freshness; it does not compare opportunities, build an action plan, or make an independent eligibility, recommendation, or human decision. Requires clientId, source (grants_gov or sam_gov), and sourceRecordId.',
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
    'Use `type` and `spec` to invoke one of six distinct existing artifact handlers; the selected handler performs type-specific validation. A single Word or PDF request stores one document spec and that artifact can be downloaded in either format; separate requests create separate artifacts. Spreadsheet uses title/sheets and saves an Excel workbook; presentation uses title/slides and saves a PowerPoint deck. meeting_brief requires meetingId and can return a background preparation job before an artifact is ready. policy_memo requires an authorized clientId; if body is omitted the handler composes it from client context and internal research, while supplied body text is stored as supplied. Put clientId and conversationId at the TOP LEVEL; conflicting nested scope values are blocked when top-level scope is present. Nested scope values remain accepted as compatibility inputs when top-level values are absent. The active conversation ID is supplied when omitted where supported; explicit IDs continue through the backing handler’s authorization checks. Existing artifact write and compliance gates remain in effect.',
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
          'Complete structured content for the selected artifact type. Put scope at top level; matching nested scope values are accepted for compatibility, conflicting values are blocked when top-level scope is present.',
        additionalProperties: true,
      },
    },
    required: ['type', 'spec'],
  },
};

/** Contracts are kept beside the feature-gated compatibility schemas without
 * being sent as additional fields to the model provider. */
export const MERI_SEMANTIC_COMPATIBILITY_CONTRACTS = {
  analyze_funding_opportunity: {
    contractRole: 'advisory_only',
    purpose:
      'Collect existing Capiro evidence for one client and one local federal funding opportunity.',
    exclusions: [
      'Comparing multiple opportunities; compare_funding_opportunities remains a separate capability.',
      'Building an opportunity action plan; build_opportunity_action_plan remains a separate capability.',
      'Making an independent eligibility, recommendation, or human pursuit decision.',
      'Direct Grants.gov or SAM.gov provider retrieval; evidence comes from Capiro-held services.',
      'A successful or complete packet whenever an underlying result is blocked, unavailable, unsupported, stale, or partial.',
      'Treating coverage.requestedDomains as proof of successful evidence retrieval; inspect toolsInvoked and each underlying result envelope.',
      'Treating the Grants.gov requirements guidance object as extracted or verified requirements.',
      'Independent validation of clientId/sourceRecordId formats; delegated readers return their own validation and availability results.',
    ],
    requiredInputs: ['clientId', 'source', 'sourceRecordId'],
    supportedScopes: [
      'one authorized client in the authenticated tenant',
      'one Grants.gov or SAM.gov record held by Capiro',
    ],
    evidenceAuthority: [
      'get_funding_opportunity local opportunity facts and held notice summary',
      'get_opportunity_client_context client opportunity posture, freshness and profile gaps',
      'explain_opportunity_match deterministic relevance, eligibility, recommendation and human-decision fields',
      'get_opportunity_government_landscape (SAM.gov only; other sources return unsupported_source)',
      'get_funding_opportunity_requirements for SAM.gov only; Grants.gov receives a notice-body continuation instruction, not extracted requirement records',
    ],
    dependencies: [
      'get_funding_opportunity',
      'get_opportunity_client_context',
      'explain_opportunity_match',
      'get_opportunity_government_landscape',
      'get_funding_opportunity_requirements for SAM.gov only',
    ],
    effectClass: 'read_only_evidence',
    availability: {
      featureFlag: 'MERI_FUNDING_SEMANTIC_TOOLS_ENABLED',
      tenantAllowlistFlag: 'MERI_FUNDING_SEMANTIC_TOOLS_TENANTS',
      tenantAllowlistFallbackFlag: 'MERI_SEMANTIC_TOOL_GATEWAY_TENANTS',
      defaultOff: true,
    },
  },
  create_artifact: {
    contractRole: 'advisory_only',
    purpose:
      'Route a typed artifact request to the matching existing Capiro writer and preserve its native result/receipt.',
    exclusions: [
      'A shared payload schema or result type across all artifact families.',
      'Converting spreadsheets, presentations, meeting briefs, or policy memos into Word/PDF content.',
      'An immediate saved meeting brief when the backing service instead returns a background preparation job.',
      'A wrapper-level guarantee that arbitrary spec objects match the selected type; each backing writer validates its own fields.',
      'Overriding the existing tenant, user, client, conversation, approval, write, or persistence checks.',
    ],
    requiredInputs: ['type', 'spec'],
    supportedScopes: [
      'authenticated tenant and user through the existing Capiro artifact handlers',
      'optional visible client scope for word, pdf, spreadsheet and presentation; policy_memo requires a clientId',
      'meeting-owned scope selected by meetingId for meeting_brief',
      'optional authorized conversation attribution checked by the backing handler',
    ],
    evidenceAuthority: [
      'Type-specific existing handler result, including artifact, download, format or meeting-preparation job fields when returned.',
      'The selected backing service’s artifact record and metadata; this wrapper does not synthesize a common artifact receipt.',
    ],
    dependencies: [
      'create_word for word and pdf',
      'create_excel for spreadsheet',
      'create_powerpoint for presentation',
      'create_meeting_brief for meeting_brief',
      'draft_policy_memo for policy_memo',
    ],
    effectClass: 'artifact_write',
    availability: {
      featureFlag: 'MERI_ARTIFACT_TOOL_V2_ENABLED',
      tenantAllowlistFlag: 'MERI_ARTIFACT_TOOL_V2_TENANTS',
      tenantAllowlistFallbackFlag: 'MERI_SEMANTIC_TOOL_GATEWAY_TENANTS',
      defaultOff: true,
    },
    typeMappings: [
      {
        type: 'word',
        handler: 'create_word',
        requiredBackingInputs: ['title', 'sections'],
        result: 'word_document; this artifact can be downloaded as DOCX or PDF',
      },
      {
        type: 'pdf',
        handler: 'create_word',
        requiredBackingInputs: ['title', 'sections'],
        result: 'pdf_document; this artifact can be downloaded as PDF or DOCX',
      },
      {
        type: 'spreadsheet',
        handler: 'create_excel',
        requiredBackingInputs: ['title', 'sheets'],
        result: 'excel_workbook',
      },
      {
        type: 'presentation',
        handler: 'create_powerpoint',
        requiredBackingInputs: ['title', 'slides'],
        result: 'powerpoint_deck',
      },
      {
        type: 'meeting_brief',
        handler: 'create_meeting_brief',
        requiredBackingInputs: ['meetingId'],
        result: 'meeting_brief artifact or preparation job',
      },
      {
        type: 'policy_memo',
        handler: 'draft_policy_memo',
        requiredBackingInputs: ['clientId'],
        result: 'policy_memo artifact and body text',
      },
    ],
  },
} as const satisfies Record<MeriSemanticCompatibilityToolName, MeriSemanticCompatibilityContract>;

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
