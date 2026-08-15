import type { MeriRetrievalRecipeTool } from '../retrieval/meri-retrieval-plan.js';
import {
  executeMeriClientChanges,
  executeMeriPortfolioChanges,
} from './meriv3-retrieval-changes.js';
import {
  executeMeriExternalCompanyResearch,
  executeMeriPortfolioOverlap,
} from './meriv3-retrieval-company.js';
import { executeMeriRelationshipBrief } from './meriv3-retrieval-relationship.js';
import type { MeriRetrievalRecipeContext } from './meriv3-retrieval-recipe-utils.js';

export {
  executeMeriExternalEntityResolution,
  type MeriRetrievalRecipeContext,
  type MeriUnderlyingToolInvoker,
} from './meriv3-retrieval-recipe-utils.js';

export interface MeriRetrievalToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const stringSchema = (description: string) => ({ type: 'string', description });
const integerSchema = (description: string) => ({ type: 'integer', description });

export const MERI_RETRIEVAL_TOOL_SCHEMAS: MeriRetrievalToolSchema[] = [
  {
    name: 'query_relationship_brief',
    description:
      'Build an entity-aware relationship and inbox brief across resolved aliases/domains, synchronized email, contacts, internal research, memory, client documents, meetings, tasks, outreach, and tracked work when available. Use FIRST for “everything I should know”, “catch me up”, relationship-history, and inbox-brief requests. Returns chronology, open commitments, people, communications, documents, evidence, and a coverage manifest.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('Company, organization, or person to investigate'),
        withinDays: integerSchema('Optional recency window in days (1-3650)'),
      },
      required: ['entity'],
    },
  },
  {
    name: 'query_client_changes',
    description:
      'Scan the selected authorized client for recent tasks, action items, outreach, mail, debriefs, tracked-bill movement, and current federal-opportunity posture. Use FIRST for “what changed with this client”, “anything happen this week”, and negative checks such as “nothing happened, right?”. The server injects the conversation client id; never choose a different client.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clientId: stringSchema('Server-pinned focused client UUID; do not invent or change it'),
        withinDays: integerSchema('Window in days (default 7, max 365)'),
        from: stringSchema('Optional ISO date/time lower bound'),
        to: stringSchema('Optional ISO date/time upper bound'),
      },
    },
  },
  {
    name: 'query_portfolio_changes',
    description:
      'Scan the authorized active client portfolio for recent tasks, action items, outreach, mail, debriefs, tracked-bill movement, client profile state, and federal-opportunity posture. Use FIRST for “what changed across my clients”, weekly portfolio briefs, and portfolio catch-ups. Returns dated changes, carryover attention, per-client coverage, current opportunity posture, pagination gaps, and unavailable sources.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        withinDays: integerSchema('Window in days (default 7, max 365)'),
        from: stringSchema('Optional ISO date/time lower bound'),
        to: stringSchema('Optional ISO date/time upper bound'),
      },
    },
  },
  {
    name: 'research_external_company',
    description:
      'Resolve and research a company whether or not it is a Capiro client. Builds a verified company evidence set, extracts capability/agency/NAICS/PSC/PE signals, searches SAM opportunities, grants and Program Elements from those signals, and names qualification gaps. Use FIRST for external-company profiles and federal-market strategy requests. Candidate matches are evidence for analysis, not automatic proof of eligibility or program fit.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('Company or organization name, alias, or domain'),
      },
      required: ['entity'],
    },
  },
  {
    name: 'query_portfolio_overlap',
    description:
      'Resolve/research an external company, scan every authorized active client profile and federal-opportunity posture, then rank overlap across capabilities, Program Elements, agencies/customers, military services, NAICS and PSC. Use FIRST for partner, teaming, overlap, or “search across clients” requests. Scores are candidate-generation signals, not proof of a teaming relationship.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('External company or organization to compare against the portfolio'),
      },
      required: ['entity'],
    },
  },
];

export function isMeriRetrievalRecipeTool(name: string): name is MeriRetrievalRecipeTool {
  return MERI_RETRIEVAL_TOOL_SCHEMAS.some((schema) => schema.name === name);
}

export async function executeMeriRetrievalRecipe(
  name: MeriRetrievalRecipeTool,
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
): Promise<unknown> {
  switch (name) {
    case 'query_relationship_brief':
      return executeMeriRelationshipBrief(input, ctx);
    case 'query_client_changes':
      return executeMeriClientChanges(input, ctx);
    case 'query_portfolio_changes':
      return executeMeriPortfolioChanges(input, ctx);
    case 'research_external_company':
      return executeMeriExternalCompanyResearch(input, ctx);
    case 'query_portfolio_overlap':
      return executeMeriPortfolioOverlap(input, ctx);
  }
}
