import { createHash } from 'node:crypto';
import type { EvidenceRequirement } from '../assurance/evidence-plan';
import type {
  DerivedRequirementInput,
  Remedy,
  RemedyKind,
  RepairContext,
  RepairRequirement,
} from './types';

export interface RemedyPlanResult {
  remedy: Remedy | null;
  reason?: 'no_requirement' | 'no_concrete_route' | 'unknown_tool' | 'tool_not_read_only' | 'failed_call_deduped';
}

export function deriveRequirement(input: DerivedRequirementInput): RepairRequirement | null {
  const { decision, claim, envelope, evidencePlan } = input;
  const exactResult = input.deterministic?.exact.result;
  const freshnessState = input.deterministic?.freshness.state;
  if (decision.kind === 'outcome' && decision.outcome === 'supported'
    && exactResult !== 'mismatch' && exactResult !== 'absent' && freshnessState !== 'stale') return null;

  const requirement = selectRequirement(evidencePlan.requirements, claim.category, envelope);
  if (!requirement) return null;
  let kind: RepairRequirement['kind'] = 'missing_evidence';
  if (freshnessState === 'stale') kind = 'stale_status';
  else if (exactResult === 'mismatch') kind = 'contradiction';
  else if (exactResult === 'absent') kind = 'missing_evidence';
  else if (decision.kind === 'failure' && decision.state === 'document_unavailable') kind = 'document_unavailable';
  else if (decision.kind === 'outcome' && decision.outcome === 'contradicted') kind = 'contradiction';
  else if (decision.kind === 'outcome' && decision.outcome === 'conflicting_evidence') kind = 'conflict';
  else if (claim.asOf && requirement.freshness === 'same_turn') kind = 'stale_status';
  return {
    claimId: claim.id,
    kind,
    evidenceClass: requirement.evidenceClass,
    toolFamilies: [...requirement.toolFamilies],
    requiredFields: [...requirement.requiredFields],
    freshness: requirement.freshness,
  };
}

export function planRemedy(requirement: RepairRequirement, context: RepairContext): RemedyPlanResult {
  for (const name of requirement.toolFamilies) {
    if (name === 'domain_specific_tools') continue;
    const registered = context.toolRegistry.get(name);
    if (!registered) continue;
    if (!registered.readOnly) return { remedy: null, reason: 'tool_not_read_only' };
    const kind = remedyKind(requirement, name);
    const args = combinedArgs(requirement, context);
    const dedupeKey = hash(`${name}:${canonicalJson(args)}`);
    if (context.failedDedupeKeys?.has(dedupeKey)) return { remedy: null, reason: 'failed_call_deduped' };
    if (context.previousRemedyKinds?.has(kind) && requirement.toolFamilies.length === 1) continue;
    return {
      remedy: {
        id: `remedy-${hash(`${requirement.claimId}:${kind}:${dedupeKey}`).slice(0, 12)}`,
        kind,
        toolCall: { name, args },
        readOnly: true,
        dedupeKey,
      },
    };
  }
  const known = requirement.toolFamilies.some((name) => context.toolRegistry.get(name));
  return { remedy: null, reason: known ? 'no_concrete_route' : 'unknown_tool' };
}

function selectRequirement(
  requirements: readonly EvidenceRequirement[],
  category: string,
  envelope: DerivedRequirementInput['envelope'],
): EvidenceRequirement | undefined {
  const matching = requirements.filter((item) => item.claimCategory === category && item.level === 'required');
  return matching.find((item) => !envelope.sources.some((source) => source.sourceType === item.evidenceClass)) ?? matching[0];
}

function combinedArgs(requirement: RepairRequirement, context: RepairContext): Record<string, unknown> {
  return {
    claimIds: [requirement.claimId],
    evidenceClass: requirement.evidenceClass,
    requiredFields: [...new Set(requirement.requiredFields)].sort(),
    freshness: requirement.freshness ?? null,
    ...(requirement.kind === 'stale_status' ? { route: 'current_status' } : {}),
    tenantId: context.tenantId,
    ...(context.clientId ? { clientId: context.clientId } : {}),
  };
}

function remedyKind(requirement: RepairRequirement, name: string): RemedyKind {
  if (requirement.kind === 'conflict' || requirement.kind === 'contradiction') return 'fetch_comparison_source';
  if (requirement.kind === 'stale_status') return 'refresh_status';
  if (/resolve|entity|member|legislator/i.test(name)) return 'resolve_entity';
  if (/document|attachment|section|transcript/i.test(name)) return 'read_document_section';
  if (/record|funding|program|award/i.test(name)) return 'inspect_structured_record';
  return 'query_primary_source';
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
