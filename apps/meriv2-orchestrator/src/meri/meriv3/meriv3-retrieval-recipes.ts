import type { MeriRuntimeRetrievalRecipeTool } from '../retrieval/meri-retrieval-plan.js';
import {
  executeMeriClientChanges,
  executeMeriPortfolioChanges,
} from './meriv3-retrieval-changes.js';
import {
  executeMeriExternalCompanyResearch,
  executeMeriFederalMarketStrategyResearch,
  executeMeriPortfolioOverlap,
} from './meriv3-retrieval-company.js';
import { executeMeriQuickCompanyProfile } from './meriv3-retrieval-company-profile.js';
import { executeMeriRelationshipBrief } from './meriv3-retrieval-relationship.js';
import { executeMeriFundingOpportunityMatch } from './meriv3-retrieval-funding-match.js';
import { executeMeriPeDeepDive } from './meriv3-retrieval-pe-deep-dive.js';
import { executeMeriBillWatch } from './meriv3-retrieval-bill-watch.js';
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
      'Build a mailbox-first relationship history from synchronized email, known contacts, and firm memory. Use FIRST for email history, inbox history, correspondence history, “catch me up”, and relationship-history requests. It performs bounded subject/contact follow-ups to recover truncated mailbox matches. It does not search LDA, SEC, federal awards, grants, Program Elements, or the public web unless the user separately asks for external-company or federal-market research.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('Company, organization, or person whose relationship history is requested'),
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
      'Research a company whether or not it is a Capiro client. For an ordinary profile or “what does this company do?” question, the runtime uses a bounded client/official/public-source lane and stops after the core capabilities are supported. For explicit federal-market, opportunity, contract, grant, Program Element, capture, or comparison requests, it uses the broader market-research lane. Do not broaden a simple profile into federal-market research.',
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
    name: 'research_federal_market_strategy',
    description:
      'Run the mandatory Research Director workflow for a comprehensive company federal-growth, capture, or pursuit strategy. Use FIRST for “comprehensive strategy”, “what PEs/grants/contracts should this company pursue”, federal growth strategy, and similar broad requests. It resolves identity; abstracts products into capabilities, operational effects and government mission vocabulary; searches internal Capiro data and public sources in multiple waves; investigates Program Elements, procurement, current and recurring acquisition channels, OTAs, consortia, marketplaces, grants/SBIR/xTech, congressional report language, OEM/prime routes, operational validation, industrial-base/finance, compliance and stakeholders; validates top budget lines with specialist readers; and returns a coverage gate and critic-ready dossier for artifact-quality synthesis. Do not replace this with a few literal keyword searches.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('Company or organization name, alias, misspelling, or domain'),
        objective: stringSchema(
          'Optional user objective or strategic emphasis; preserve the user’s broad request when omitted',
        ),
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
  {
    name: 'query_funding_opportunity_match',
    description:
      'Discover active funding opportunities (SAM.gov / Grants.gov) and score their fit against one authorized client: client capability/award context, agency/program landscape, and a per-candidate match verdict with citations. Use FIRST for “find funding opportunities for [client]”, “is this opportunity a good fit”, and opportunity-match questions. Opportunity comparison across known records and action-plan generation are separate tools, not part of this recipe.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clientId: stringSchema('Authorized client UUID the match is scored against'),
        query: stringSchema('Optional keyword filter for the opportunity search'),
      },
    },
  },
];

export function isMeriRetrievalRecipeTool(name: string): name is MeriRuntimeRetrievalRecipeTool {
  return MERI_RETRIEVAL_TOOL_SCHEMAS.some((schema) => schema.name === name);
}

function useBoundedCompanyProfile(ctx: MeriRetrievalRecipeContext): boolean {
  return ['lookup', 'semantic_recall', 'entity_history', 'temporal_state'].includes(
    ctx.plan.queryClass,
  );
}

export async function executeMeriRetrievalRecipe(
  name: MeriRuntimeRetrievalRecipeTool,
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
      return useBoundedCompanyProfile(ctx)
        ? executeMeriQuickCompanyProfile(input, ctx)
        : executeMeriExternalCompanyResearch(input, ctx);
    case 'research_federal_market_strategy':
      return executeMeriFederalMarketStrategyResearch(input, ctx);
    case 'query_portfolio_overlap':
      return executeMeriPortfolioOverlap(input, ctx);
    case 'query_funding_opportunity_match':
      return executeMeriFundingOpportunityMatch(input, ctx);
    case 'query_pe_deep_dive':
      return executeMeriPeDeepDive(input, ctx);
    case 'query_bill_watch':
      return executeMeriBillWatch(input, ctx);
  }
}
