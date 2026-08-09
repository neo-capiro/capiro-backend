import type { ReasoningProviderTool } from './outreach-reasoning.contract.js';

export const OUTREACH_REASONING_READ_TOOL_NAMES = [
  'get_capiro_record',
  'get_client_context',
  'get_recent_activity',
] as const;

export type OutreachReasoningReadToolName = (typeof OUTREACH_REASONING_READ_TOOL_NAMES)[number];

const uuidSchema = { type: 'string', format: 'uuid' } as const;

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
      throw new Error(`External/write tool is prohibited from Phase 3 reasoning: ${tool.name}`);
    }
    seen.add(tool.name);
  }

  if (seen.size !== OUTREACH_REASONING_READ_TOOL_NAMES.length) {
    throw new Error('Outreach reasoning read-tool contract is incomplete.');
  }
}

assertOutreachReasoningToolContract();
