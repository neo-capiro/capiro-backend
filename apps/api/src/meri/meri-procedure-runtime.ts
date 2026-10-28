import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import type { MeriGovernedProcedureBinding } from '@capiro/meriv2-core';
import type { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import type {
  MeriProcedureBinding,
  MeriProcedureManifest,
  MeriSkill,
} from './skills/skill.types.js';

const PROCEDURE_BINDING_TTL_MS = 5 * 60_000;

const PROCEDURE_CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'client.read': ['get_client_context'],
  'mail.read': ['list_emails', 'search_emails', 'get_email_thread'],
  'meetings.read': ['list_upcoming_meetings', 'read_client_meetings'],
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
  /**
   * Digest of the exact normalized manifest this turn is bound to. The receipt
   * is what the turn emits, persists and logs, so without it a stored turn can
   * not be traced back to the procedure version that actually ran.
   */
  manifestDigest: string;
  scope: MeriGovernedProcedureBinding['scope'];
  clientId: string | null;
  effectMode: MeriGovernedProcedureBinding['policy']['effectMode'];
  /** The read surface actually granted, after registry and effect-mode filtering. */
  allowedTools: string[];
  caseIds: string[];
  completionCheckCount: number;
  coverageStates: string[];
}

/**
 * The exact identity digest of a normalized procedure manifest. Single owner for
 * both the signed governed binding and the admin read path, so a version shown
 * in settings is the same version the runtime signed.
 */
export function procedureManifestDigest(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
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

  return resolveCurrentServedProcedure({
    tenantId: input.tenantId,
    clientId: input.clientId,
    reference: selectedBinding,
    firmSkills: input.firmSkills,
    now: input.now,
  });
}

export interface ProcedureProjectionInput {
  clientId: string | null;
  manifest: MeriProcedureManifest;
  instruction: string;
  requiredTools: readonly string[];
  clientRequired: boolean;
  now: number;
}

export interface ProcedureProjection {
  manifestDigest: string;
  instruction: string;
  scope: MeriGovernedProcedureBinding['scope'];
  clientId: string | null;
  clientRequired: boolean;
  resolvedAt: number;
  validUntil: number;
  policy: MeriGovernedProcedureBinding['policy'];
  contract: MeriGovernedProcedureBinding['contract'];
}

/**
 * Single projection of a normalized procedure manifest into served policy.
 * Both the tenant firm-row path and the canonical builtin path call this, so a
 * builtin can never be projected more narrowly or more widely than a firm row
 * with the same manifest. The manifest's capabilities define the maximum
 * requested read surface; requiredTools remain mandatory workflow dependencies,
 * not the complete allow-list. The canonical registry and current runtime
 * schemas still get the final say at exposure and invocation.
 */
export function projectProcedureBinding(input: ProcedureProjectionInput): ProcedureProjection {
  const { manifest } = input;
  const scope: MeriGovernedProcedureBinding['scope'] = input.clientId ? 'client' : 'general';
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
  const requiredTools = [...new Set(input.requiredTools)];
  const allowedTools = [...capabilityTools].filter((name) => {
    const capability = canonicalTools.get(name);
    return Boolean(
      capability && (manifest.effectPolicy.mode !== 'read_only' || capability.readOnly === true),
    );
  });
  if (requiredTools.some((name) => !allowedTools.includes(name))) {
    throw new NotFoundException('Procedure binding is unavailable');
  }

  return {
    manifestDigest: procedureManifestDigest(manifest),
    instruction: input.instruction,
    scope,
    clientId: input.clientId,
    clientRequired: input.clientRequired,
    resolvedAt: input.now,
    validUntil: input.now + PROCEDURE_BINDING_TTL_MS,
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
}

/** Re-resolve and project one exact procedure reference without a cache. */
export async function resolveCurrentServedProcedure(input: {
  tenantId: string;
  clientId: string | null;
  reference: MeriProcedureBinding;
  firmSkills: Pick<MeriFirmSkillsService, 'resolveProcedureReference'>;
  now?: number;
}): Promise<{ binding: MeriGovernedProcedureBinding; receipt: ServedProcedureReceipt }> {
  const resolved = await input.firmSkills.resolveProcedureReference(
    input.tenantId,
    input.reference,
  );
  const manifest = resolved.procedure;
  const identity = resolved.procedureBinding;
  if (!manifest || !identity) throw new NotFoundException('Procedure binding is unavailable');

  const clientRequired = resolved.id === 'commitments_audit';
  if (clientRequired && !input.clientId) {
    throw new BadRequestException('Commitments & Deliverables requires a selected client');
  }

  const binding: MeriGovernedProcedureBinding = {
    version: 1,
    tenantId: input.tenantId,
    identity: { ...identity },
    ...projectProcedureBinding({
      clientId: input.clientId,
      manifest,
      instruction: resolved.systemAddendum,
      requiredTools: resolved.requiredTools,
      clientRequired,
      now: input.now ?? Date.now(),
    }),
  };
  return { binding, receipt: procedureReceipt(binding) };
}

export function procedureReceipt(binding: MeriGovernedProcedureBinding): ServedProcedureReceipt {
  return {
    id: binding.identity.canonicalId,
    version: binding.identity.version,
    source: binding.identity.source,
    manifestDigest: binding.manifestDigest,
    scope: binding.scope,
    clientId: binding.clientId,
    effectMode: binding.policy.effectMode,
    allowedTools: [...binding.policy.allowedTools],
    caseIds: [...binding.contract.caseIds],
    completionCheckCount: binding.contract.completionChecks.length,
    coverageStates: [...binding.contract.coverageStates],
  };
}
