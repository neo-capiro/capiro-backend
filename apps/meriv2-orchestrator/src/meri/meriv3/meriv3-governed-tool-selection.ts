import type { DomainEvidencePlan, MeriContext, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { classifyMeriRetrievalIntent } from '../retrieval/meri-retrieval-intent.js';
import {
  buildMeriRetrievalPlan,
  type MeriRetrievalPlan,
} from '../retrieval/meri-retrieval-plan.js';
import type { CoverageRequirement } from '../retrieval/meri-evidence-requirements.js';
import type { MeriV3ChatInput } from './meriv3.types.js';

const GENERIC_TOOL_FAMILIES = new Set(['domain_specific_tools']);
const SKIPPED_RESEARCH_DIRECTOR = 'research_federal_market_strategy';

export interface MeriGovernedToolSelectionContext {
  plan: MeriRetrievalPlan;
  recentUserContext: string;
  protectedNames: string[];
  discoveryNames: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function recentUserContext(dto: MeriV3ChatInput): string {
  return (dto.messages ?? [])
    .filter((message) => message?.role === 'user')
    .slice(-3)
    .flatMap((message) => (typeof message.text === 'string' ? [message.text.trim()] : []))
    .filter(Boolean)
    .join('\n');
}

function priorUserTargetHint(dto: MeriV3ChatInput): string | null {
  const users = (dto.messages ?? []).filter(
    (message) => message?.role === 'user' && typeof message.text === 'string',
  );
  for (let index = users.length - 2; index >= 0; index -= 1) {
    const text = users[index]?.text;
    if (typeof text !== 'string') continue;
    const target = classifyMeriRetrievalIntent(text, null).targetHint;
    if (target) return target;
  }
  return null;
}

function withoutSkippedResearchDirector(plan: MeriRetrievalPlan): MeriRetrievalPlan {
  if (plan.recipeTool !== SKIPPED_RESEARCH_DIRECTOR) return plan;
  return {
    ...plan,
    recipeTool: null,
    recommendedTools: plan.recommendedTools.filter((name) => name !== SKIPPED_RESEARCH_DIRECTOR),
    reasons: plan.reasons.filter(
      (reason) =>
        reason !== `recipe:${SKIPPED_RESEARCH_DIRECTOR}` && reason !== 'research-director-required',
    ),
  };
}

function exactNamesInTrustedInputs(names: readonly string[], dto: MeriV3ChatInput): string[] {
  // These fields are server-authored procedure/policy inputs. User messages and
  // summaries are deliberately excluded so plain text cannot name-enable a tool.
  const trusted = [dto.skillAddendum, dto.researchDirective, dto.prospectDirective]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .slice(0, 64_000);
  if (!trusted) return [];
  return names.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`).test(trusted);
  });
}

/**
 * Builds request-local selector inputs from existing authoritative plans. Every
 * returned name is still intersected with the API's authorized schema surface by
 * MeriSemanticToolGateway; this helper grants no capability by itself.
 */
export function buildMeriGovernedToolSelectionContext(input: {
  ctx: MeriContext;
  dto: MeriV3ChatInput;
  request: string;
  authorizedNames: readonly string[];
  evidencePlan: DomainEvidencePlan;
  coverageRequirements: readonly CoverageRequirement[];
  governedContext?: MeriGovernedTurnContext | null;
  documentReadRequired?: boolean;
}): MeriGovernedToolSelectionContext {
  const intent = classifyMeriRetrievalIntent(input.request, input.dto.clientId ?? null);
  const plan = withoutSkippedResearchDirector(
    buildMeriRetrievalPlan(input.request, intent, input.ctx, priorUserTargetHint(input.dto)),
  );
  const requiredEvidenceTools = input.evidencePlan.requirements
    .filter((requirement) => requirement.level === 'required')
    .flatMap((requirement) => requirement.toolFamilies)
    .filter((name) => !GENERIC_TOOL_FAMILIES.has(name));
  const essentialCoverageTools = input.coverageRequirements
    .filter((requirement) => requirement.essential)
    .flatMap((requirement) => requirement.toolFamilies)
    .filter((name) => !GENERIC_TOOL_FAMILIES.has(name));
  const documentTools =
    input.documentReadRequired || input.dto.selectedDocumentIds?.length
      ? ['read_client_documents']
      : [];
  const governedCoverage = input.governedContext?.retrieval?.coverage;
  const governedCoverageTools =
    governedCoverage?.complete === false ? governedCoverage.toolsInvoked : [];
  const trustedProcedureTools = exactNamesInTrustedInputs(input.authorizedNames, input.dto);

  return {
    plan,
    recentUserContext: recentUserContext(input.dto),
    protectedNames: unique([
      ...requiredEvidenceTools,
      ...essentialCoverageTools,
      ...documentTools,
      ...governedCoverageTools,
      ...trustedProcedureTools,
    ]),
    // Exact names from deterministic plans are a bounded fallback in the
    // gateway. This is not a model-callable progressive discovery catalog.
    discoveryNames: unique(plan.recommendedTools),
  };
}
