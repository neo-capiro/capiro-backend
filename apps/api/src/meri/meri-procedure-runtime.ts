import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import type { MeriGovernedProcedureBinding } from '@capiro/meriv2-core';
import type { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import type { MeriSkill } from './skills/skill.types.js';

const PROCEDURE_BINDING_TTL_MS = 5 * 60_000;

const PROCEDURE_CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'client.read': ['get_client_context'],
  'mail.read': ['list_emails', 'search_emails', 'get_email_thread'],
  'meetings.read': ['list_upcoming_meetings'],
  'debriefs.read': ['query_debriefs'],
  'tasks.read': ['query_tasks'],
  'action_items.read': ['query_action_items'],
  'documents.read': ['read_client_documents'],
  // The canonical cross-domain reader owns mapped Monday reads today.
  'monday.read': ['search_capiro_data'],
};

export interface ServedProcedureReceipt {
  id: string;
  version: number;
  source: 'firm';
  scope: MeriGovernedProcedureBinding['scope'];
  clientId: string | null;
  effectMode: MeriGovernedProcedureBinding['policy']['effectMode'];
  caseIds: string[];
  completionCheckCount: number;
  coverageStates: string[];
}

/**
 * Resolves a cached selector result against the current tenant row and projects
 * only canonical, registry-backed authority into the signed turn context.
 */
export async function resolveServedProcedure(input: {
  tenantId: string;
  clientId: string | null;
  selected: MeriSkill | null;
  firmSkills: Pick<MeriFirmSkillsService, 'resolveProcedureReference'>;
  now?: number;
}): Promise<{ binding: MeriGovernedProcedureBinding; receipt: ServedProcedureReceipt } | null> {
  const selectedBinding = input.selected?.procedureBinding;
  if (!input.selected?.procedure || !selectedBinding) return null;

  const resolved = await input.firmSkills.resolveProcedureReference(input.tenantId, selectedBinding);
  const manifest = resolved.procedure;
  const identity = resolved.procedureBinding;
  if (!manifest || !identity) throw new NotFoundException('Procedure binding is unavailable');

  const clientRequired = resolved.id === 'commitments_audit';
  if (clientRequired && !input.clientId) {
    throw new BadRequestException('Commitments & Deliverables requires a selected client');
  }
  const scope = input.clientId ? 'client' : 'general';
  if (!manifest.scopes.includes(scope)) {
    throw new BadRequestException('Procedure is not permitted in the selected scope');
  }

  const canonicalTools = new Map<string, { readOnly: boolean }>(
    MERI_CAPABILITY_REGISTRY.map((capability) => [capability.name, capability]),
  );
  const capabilityTools = new Set(
    manifest.allowedCapabilities.flatMap(
      (capability) => PROCEDURE_CAPABILITY_TOOLS[capability] ?? [],
    ),
  );
  const requiredTools = [...new Set(resolved.requiredTools)];
  const allowedTools = requiredTools.filter((name) => {
    const capability = canonicalTools.get(name);
    return Boolean(
      capabilityTools.has(name) &&
        capability &&
        (manifest.effectPolicy.mode !== 'read_only' || capability.readOnly === true),
    );
  });
  if (allowedTools.length !== requiredTools.length) {
    throw new NotFoundException('Procedure binding is unavailable');
  }

  const now = input.now ?? Date.now();
  const binding: MeriGovernedProcedureBinding = {
    version: 1,
    tenantId: input.tenantId,
    identity: { ...identity },
    manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    instruction: resolved.systemAddendum,
    scope,
    clientId: input.clientId,
    clientRequired,
    resolvedAt: now,
    validUntil: now + PROCEDURE_BINDING_TTL_MS,
    policy: {
      effectMode: manifest.effectPolicy.mode,
      allowedCapabilities: [...manifest.allowedCapabilities],
      allowedTools,
      requiredTools,
    },
    contract: {
      outputFields: [...manifest.output.fields],
      completionChecks: [...manifest.completion],
      coverageStates: [...manifest.output.coverageStates],
      caseIds: [...manifest.caseIds],
    },
  };
  return { binding, receipt: procedureReceipt(binding) };
}

export function procedureReceipt(binding: MeriGovernedProcedureBinding): ServedProcedureReceipt {
  return {
    id: binding.identity.canonicalId,
    version: binding.identity.version,
    source: binding.identity.source,
    scope: binding.scope,
    clientId: binding.clientId,
    effectMode: binding.policy.effectMode,
    caseIds: [...binding.contract.caseIds],
    completionCheckCount: binding.contract.completionChecks.length,
    coverageStates: [...binding.contract.coverageStates],
  };
}
