import { createHash, randomUUID } from 'node:crypto';
import type {
  CompiledContextPacket,
  CompiledContextPacketV2,
  ContextPacketHealth,
  ContextRequest,
  ContextSurface,
  SteeringLayer,
  TruthfulCompiledContextPacket,
  TruthfulContextStoreAdapter,
} from './contract';
import {
  appliedContextSurfacePolicy,
  contextSurfacePolicy,
  type ContextSurfacePolicy,
} from './surface-policy';
import type { ContextPacketMode } from './context-release-switch';
import { CONTEXT_POLICY_VERSION } from './context-release-switch';
import {
  contextPacketPersistenceErrorCode,
  TruthfulContextCompiler,
} from './truthful-compiler';

export const CONTEXT_COMPILER_PHASE8_VERSION = 'context-compiler-v2.1';

export interface ContextPacketShadowComparison {
  mode: 'shadow';
  surface: ContextSurface;
  baselinePacketId: string | null;
  shadowPacketId: string | null;
  baselineTraceHash: string;
  shadowTraceHash: string | null;
  baselineItemIds: string[];
  shadowItemIds: string[];
  onlyInBaseline: string[];
  onlyInShadow: string[];
  orderingChanged: boolean;
  baselineExclusionReasons: Record<string, number>;
  shadowExclusionReasons: Record<string, number>;
  shadowHealth: string | null;
  missingRequiredLayers: SteeringLayer[];
  missingOptionalLayers: SteeringLayer[];
  conflictDelta: number;
  tokenDelta: number | null;
  confidentialityRegression: boolean;
  shadowErrorCode: string | null;
}

export interface ContextPacketRolloutStoreAdapter extends TruthfulContextStoreAdapter {
  /** Persist bounded comparison metadata only; never packet bodies. */
  persistShadowComparison?(input: {
    tenantId: string;
    comparisonPacketId: string;
    comparison: ContextPacketShadowComparison;
  }): Promise<void>;
}

export type Phase8ContextPacket = CompiledContextPacket & {
  optionalLayers?: SteeringLayer[];
};

interface Phase8Health extends ContextPacketHealth {
  missingOptionalLayers: SteeringLayer[];
}

/**
 * Phase 8 rollout owner.
 *
 * - off: one byte-compatible v1 compile; governed columns are never read.
 * - shadow: compile/persist v1, compile/persist v2 best-effort, return v1 unchanged.
 * - enforce: compile/persist v2 using the explicit surface policy.
 */
export class ContextPacketRolloutCompiler {
  private readonly truthful: TruthfulContextCompiler;

  constructor(private readonly store: ContextPacketRolloutStoreAdapter) {
    this.truthful = new TruthfulContextCompiler(store);
  }

  async compile(req: ContextRequest, mode: ContextPacketMode): Promise<Phase8ContextPacket> {
    const baselineRequest = stripRequestTimeV2Hints(req);
    if (mode === 'off') {
      return this.truthful.compile(baselineRequest);
    }

    if (mode === 'enforce') {
      const request = v2Request(baselineRequest, 'enforce');
      return this.truthful.compile(request, (compiled) =>
        finalizeV2Packet(compiled, contextSurfacePolicy(req.surface)),
      );
    }

    const baseline = await this.truthful.compile(baselineRequest);
    let shadow: TruthfulCompiledContextPacket | null = null;
    let shadowErrorCode: string | null = null;
    try {
      shadow = await this.truthful.compile(v2Request(baselineRequest, 'shadow'), (compiled) =>
        finalizeV2Packet(compiled, contextSurfacePolicy(req.surface)),
      );
      shadowErrorCode = shadow.persistenceErrorCode;
    } catch (error) {
      shadowErrorCode = contextPacketPersistenceErrorCode(error);
    }

    const comparison = comparePackets(baseline, shadow, shadowErrorCode);
    const comparisonPacketId = shadow?.persistedPacketId ?? baseline.persistedPacketId;
    if (comparisonPacketId && this.store.persistShadowComparison) {
      try {
        await this.store.persistShadowComparison({
          tenantId: req.tenantId,
          comparisonPacketId,
          comparison,
        });
      } catch {
        // Comparison persistence is observability only. It must never alter v1 output.
      }
    }

    // Shadow mode must be indistinguishable from off to model and product callers.
    return baseline;
  }
}

function stripRequestTimeV2Hints(req: ContextRequest): ContextRequest {
  const {
    contractVersion: _contractVersion,
    policyVersion: _policyVersion,
    compilerVersion: _compilerVersion,
    tokenBudget: _tokenBudget,
    budgetUnit: _budgetUnit,
    persistence: _persistence,
    allowedSensitivities: _allowedSensitivities,
    ...base
  } = req;
  return { ...base, contractVersion: 1 };
}

function v2Request(req: ContextRequest, mode: 'shadow' | 'enforce'): ContextRequest {
  const policy = contextSurfacePolicy(req.surface);
  const applied = appliedContextSurfacePolicy(req.surface, req.clientId);
  return {
    ...req,
    contractVersion: 2,
    layers: [...applied.layers],
    traceId: req.traceId ?? randomUUID(),
    promptVersion: req.promptVersion ?? null,
    policyVersion: CONTEXT_POLICY_VERSION,
    compilerVersion: CONTEXT_COMPILER_PHASE8_VERSION,
    allowedSensitivities: [...policy.allowedSensitivities],
    tokenBudget: policy.tokenBudget,
    budgetUnit: 'tokens',
    // A shadow trace may fail, but it may never block or change the v1 response.
    persistence: mode === 'shadow' ? 'best-effort' : policy.persistence,
    ethicalWallAllowed: req.ethicalWallAllowed === true,
  };
}

function finalizeV2Packet(
  packet: TruthfulCompiledContextPacket,
  policy: ContextSurfacePolicy,
): TruthfulCompiledContextPacket {
  if (packet.version !== 2) return packet;
  const applied = appliedContextSurfacePolicy(packet.surface, packet.clientId);
  const includedLayers = new Set(packet.items.map((item) => item.layer));
  const missingRequiredLayers = applied.requiredLayers.filter(
    (layer) => !includedLayers.has(layer),
  );
  const missingOptionalLayers = applied.optionalLayers.filter(
    (layer) => !includedLayers.has(layer),
  );
  const requiredLayerSet = new Set(applied.requiredLayers);
  const requiredSourceFailureCount = packet.exclusions.filter(
    (item) =>
      requiredLayerSet.has(item.layer) && ['source-missing', 'unavailable'].includes(item.reason),
  ).length;

  const reasons = packet.health.reasons.filter(
    (reason) =>
      !reason.startsWith('Missing required layers:') && !reason.endsWith('source failure(s)'),
  );
  if (missingRequiredLayers.length) {
    reasons.push(`Missing required layers: ${missingRequiredLayers.join(', ')}`);
  }
  if (requiredSourceFailureCount) {
    reasons.push(`${requiredSourceFailureCount} required source failure(s)`);
  }

  const status: ContextPacketHealth['status'] = packet.truncated
    ? 'incomplete'
    : packet.health.conflictCount > 0
      ? 'conflicted'
      : requiredSourceFailureCount > 0 || missingRequiredLayers.length > 0
        ? 'degraded'
        : 'healthy';

  const health: Phase8Health = {
    ...packet.health,
    status,
    missingRequiredLayers: [...missingRequiredLayers],
    missingOptionalLayers: [...missingOptionalLayers],
    sourceFailureCount: requiredSourceFailureCount,
    reasons,
  };
  packet.requiredLayers = [...applied.requiredLayers];
  packet.health = health;
  packet.incomplete = status !== 'healthy';
  packet.compilerVersion = CONTEXT_COMPILER_PHASE8_VERSION;
  Object.assign(packet, { optionalLayers: [...applied.optionalLayers] });

  if (policy.renderEnvelope === 'plain') {
    packet.rendered = packet.rendered.map((item) => ({
      ...item,
      body: removeOuterContextEnvelope(item.body),
    }));
  }
  packet.traceHash = packetTraceHash(packet);
  return packet;
}

function comparePackets(
  baseline: TruthfulCompiledContextPacket,
  shadow: TruthfulCompiledContextPacket | null,
  shadowErrorCode: string | null,
): ContextPacketShadowComparison {
  const baselineIds = baseline.items.map((item) => item.id).slice(0, 200);
  const shadowIds = shadow?.items.map((item) => item.id).slice(0, 200) ?? [];
  const baselineSet = new Set(baselineIds);
  const shadowSet = new Set(shadowIds);
  const shadowV2 = shadow?.version === 2 ? shadow : null;
  const shadowHealth = shadowV2?.health as Phase8Health | undefined;
  return {
    mode: 'shadow',
    surface: baseline.surface,
    baselinePacketId: baseline.persistedPacketId ?? null,
    shadowPacketId: shadow?.persistedPacketId ?? null,
    baselineTraceHash: baseline.traceHash,
    shadowTraceHash: shadow?.traceHash ?? null,
    baselineItemIds: baselineIds,
    shadowItemIds: shadowIds,
    onlyInBaseline: baselineIds.filter((id) => !shadowSet.has(id)),
    onlyInShadow: shadowIds.filter((id) => !baselineSet.has(id)),
    orderingChanged: JSON.stringify(baselineIds) !== JSON.stringify(shadowIds),
    baselineExclusionReasons: reasonCounts(baseline),
    shadowExclusionReasons: shadow ? reasonCounts(shadow) : {},
    shadowHealth: shadowV2?.health.status ?? null,
    missingRequiredLayers: [...(shadowV2?.health.missingRequiredLayers ?? [])],
    missingOptionalLayers: [...(shadowHealth?.missingOptionalLayers ?? [])],
    conflictDelta: (shadowV2?.health.conflictCount ?? 0) - conflictCount(baseline),
    tokenDelta:
      shadowV2 == null
        ? null
        : shadowV2.usedTokens -
          Math.ceil(baseline.rendered.reduce((sum, item) => sum + item.body.length, 0) / 4),
    confidentialityRegression: shadow ? hasConfidentialityRegression(shadow) : false,
    shadowErrorCode,
  };
}

function reasonCounts(packet: CompiledContextPacket): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const exclusion of packet.exclusions) {
    counts[exclusion.reason] = (counts[exclusion.reason] ?? 0) + 1;
  }
  return counts;
}

function conflictCount(packet: CompiledContextPacket): number {
  return packet.version === 2 ? packet.health.conflictCount : 0;
}

function hasConfidentialityRegression(packet: CompiledContextPacket): boolean {
  const withheld = new Set(['unauthorized', 'wrong-client', 'sensitivity-denied']);
  if (
    packet.exclusions.some(
      (item) => withheld.has(item.reason) && Boolean(item.id || item.type || item.slug),
    )
  ) {
    return true;
  }
  if (packet.version !== 2) return false;

  const allowedSensitivities = new Set(contextSurfacePolicy(packet.surface).allowedSensitivities);
  return packet.items.some((item) => {
    if (!allowedSensitivities.has(item.sensitivity)) return true;
    if (item.scope === 'client' && (!packet.clientId || item.clientId !== packet.clientId)) {
      return true;
    }
    if (item.scope === 'user_private' && (!packet.userId || item.ownerUserId !== packet.userId)) {
      return true;
    }
    return false;
  });
}

function removeOuterContextEnvelope(body: string): string {
  return body
    .replace(/^<context_item\b[^>]*>\s*/u, '')
    .replace(/\s*<\/context_item>$/u, '')
    .trim();
}

function packetTraceHash(packet: CompiledContextPacketV2): string {
  const rendered = packet.rendered.map((item) => ({
    layer: item.layer,
    id: item.id,
    type: item.type,
    slug: item.slug,
    contentHash: item.contentHash,
    bodyHash: createHash('sha256').update(item.body).digest('hex'),
    instructionsAllowed: item.instructionsAllowed ?? false,
  }));
  return createHash('sha256')
    .update(
      stableJson({
        version: packet.version,
        surface: packet.surface,
        tenantId: packet.tenantId,
        effectiveTenantId: packet.effectiveTenantId,
        actorUserId: packet.actorUserId,
        userId: packet.userId,
        clientId: packet.clientId,
        ref: packet.ref,
        traceId: packet.traceId,
        promptVersion: packet.promptVersion,
        policyVersion: packet.policyVersion,
        compilerVersion: packet.compilerVersion,
        requiredLayers: packet.requiredLayers,
        optionalLayers: (packet as Phase8ContextPacket).optionalLayers ?? [],
        items: packet.items,
        exclusions: packet.exclusions,
        rendered,
        health: packet.health,
        totalTokenBudget: packet.totalTokenBudget,
        usedTokens: packet.usedTokens,
        truncated: packet.truncated,
        incomplete: packet.incomplete,
      }),
    )
    .digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
