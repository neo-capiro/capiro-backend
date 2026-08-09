import type { ReasoningProviderTool } from './outreach-reasoning.contract.js';

export const OUTREACH_REASONING_READ_TOOL_NAMES = [
  'get_capiro_record',
  'get_client_context',
  'get_recent_activity',
  'search_targets',
  'get_target_profile',
  'analyze_relationships',
  'analyze_target_coverage',
  'find_similar_targets',
  'search_memory',
  'research_government',
  'get_document',
  'recommend_outreach_strategy',
] as const;

export type OutreachReasoningReadToolName = (typeof OUTREACH_REASONING_READ_TOOL_NAMES)[number];

const uuidSchema = { type: 'string', format: 'uuid' } as const;
const nullableUuidSchema = { anyOf: [uuidSchema, { type: 'null' }] } as const;
const nullableStringSchema = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const contextClassSchema = {
  type: 'string',
  enum: [
    'required_policy',
    'writing_guidance',
    'campaign_fact',
    'target_specific',
    'group_safe',
  ],
} as const;
const contextScopeSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['campaign'] } },
      required: ['kind'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['target'] },
        targetKey: { type: 'string', minLength: 1, maxLength: 384 },
      },
      required: ['kind', 'targetKey'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['group'] },
        groupRef: { type: 'string', minLength: 1, maxLength: 160 },
      },
      required: ['kind', 'groupRef'],
    },
  ],
} as const;

const targetRefSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['directory_member'] },
        id: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['source', 'id'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['directory_staff'] },
        id: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['source', 'id'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['state_legislator'] },
        id: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['source', 'id'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['client_person'] },
        id: uuidSchema,
        clientId: uuidSchema,
      },
      required: ['source', 'id', 'clientId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['engagement_contact'] },
        id: uuidSchema,
        clientId: nullableUuidSchema,
      },
      required: ['source', 'id', 'clientId'],
    },
  ],
} as const;

export const OUTREACH_REASONING_READ_TOOLS: readonly ReasoningProviderTool[] = Object.freeze([
  {
    type: 'function',
    name: 'get_capiro_record',
    description:
      'Read one already-existing Capiro client, meeting, or engagement task. Authorization and client scope are rechecked by Capiro.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recordType: { type: 'string', enum: ['client', 'meeting', 'engagement_task'] },
        recordId: uuidSchema,
      },
      required: ['recordType', 'recordId'],
    },
  },
  {
    type: 'function',
    name: 'get_client_context',
    description:
      'Return bounded authorized context for one specific Capiro client. Use only when a client is relevant to the current campaign.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { clientId: uuidSchema },
      required: ['clientId'],
    },
  },
  {
    type: 'function',
    name: 'get_recent_activity',
    description:
      'Return recent authorized meetings and commitments for one specific Capiro client.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clientId: uuidSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['clientId', 'limit'],
    },
  },
  {
    type: 'function',
    name: 'search_targets',
    description:
      'Search explainable government-affairs targets. Campaign criteria, selected targets and rejected recommendations are supplied by Capiro.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: nullableStringSchema,
        clientId: nullableUuidSchema,
        sources: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'string',
            enum: [
              'directory_member',
              'directory_staff',
              'state_legislator',
              'client_person',
              'engagement_contact',
              'client_recommendation',
            ],
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query', 'clientId', 'sources', 'limit'],
    },
  },
  {
    type: 'function',
    name: 'get_target_profile',
    description:
      'Read the current source-aware profile for one target reference with explicit unavailable, stale and restricted sections.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { targetRef: targetRefSchema },
      required: ['targetRef'],
    },
  },
  {
    type: 'function',
    name: 'analyze_relationships',
    description:
      'Analyze client-scoped meeting, email-envelope and task metadata for one target. It never returns private note or message bodies.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { targetRef: targetRefSchema, clientId: uuidSchema },
      required: ['targetRef', 'clientId'],
    },
  },
  {
    type: 'function',
    name: 'analyze_target_coverage',
    description:
      'Analyze the canonical selected target set for contactability and requested audience coverage. Capiro supplies the target set and criteria.',
    strict: true,
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'find_similar_targets',
    description:
      'Find authorized targets similar to one known target by role, chamber, state, committee and issue portfolio.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetRef: targetRefSchema,
        clientId: nullableUuidSchema,
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['targetRef', 'clientId', 'limit'],
    },
  },
  {
    type: 'function',
    name: 'search_memory',
    description:
      'Search active governed institutional memory. Results include exact context selections and whether they may be used as evidence or writing guidance.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 500 },
        clientId: nullableUuidSchema,
        intendedClass: contextClassSchema,
        scope: contextScopeSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query', 'clientId', 'intendedClass', 'scope', 'limit'],
    },
  },
  {
    type: 'function',
    name: 'research_government',
    description:
      'Search source-backed government datasets and return exact references for context review. It does not create policy or infer facts.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 500 },
        categories: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'string',
            enum: [
              'bill',
              'award',
              'lda_filing',
              'hearing',
              'sec_filing',
              'fara_registration',
              'gao_report',
              'crs_report',
              'regulatory_docket',
              'intel_article',
              'state_bill',
              'federal_register',
            ],
          },
        },
        intendedClass: {
          type: 'string',
          enum: ['required_policy', 'campaign_fact', 'target_specific', 'group_safe'],
        },
        scope: contextScopeSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query', 'categories', 'intendedClass', 'scope', 'limit'],
    },
  },
  {
    type: 'function',
    name: 'get_document',
    description:
      'Inspect one authorized Capiro document as bounded context metadata; raw file bytes and storage credentials are never returned.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        documentId: uuidSchema,
        clientId: nullableUuidSchema,
        intendedClass: contextClassSchema,
        scope: contextScopeSchema,
      },
      required: ['documentId', 'clientId', 'intendedClass', 'scope'],
    },
  },
  {
    type: 'function',
    name: 'recommend_outreach_strategy',
    description:
      'Recommend delivery pattern, personalization, tone and length from canonical Campaign Spec, target health and accepted-context counts supplied by Capiro.',
    strict: true,
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
]);

const allowed = new Set<string>(OUTREACH_REASONING_READ_TOOL_NAMES);

export function isOutreachReasoningReadTool(name: string): name is OutreachReasoningReadToolName {
  return allowed.has(name);
}

export function assertOutreachReasoningToolContract(): void {
  const seen = new Set<string>();
  for (const tool of OUTREACH_REASONING_READ_TOOLS) {
    if (tool.type !== 'function') throw new Error(`Outreach reasoning tool must be a function: ${tool.name}`);
    if (!allowed.has(tool.name)) throw new Error(`Unapproved Outreach reasoning tool: ${tool.name}`);
    if (seen.has(tool.name)) throw new Error(`Duplicate Outreach reasoning tool: ${tool.name}`);
    if (/send|mail|generate|draft|write|update|delete|create|oauth|recall|s3/i.test(tool.name)) {
      throw new Error(`External/write tool is prohibited from Outreach reasoning: ${tool.name}`);
    }
    seen.add(tool.name);
  }
  if (seen.size !== OUTREACH_REASONING_READ_TOOL_NAMES.length) {
    throw new Error('Outreach reasoning read-tool contract is incomplete.');
  }
}

assertOutreachReasoningToolContract();
