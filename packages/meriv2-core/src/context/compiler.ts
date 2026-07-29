/** Versioned deterministic context compilation and auditable exclusions. */
import { createHash, randomUUID } from 'node:crypto';
import {
  classifyLegacyMemory,
  filterGovernedMemory,
  instructionsAllowedFor,
  scoreGovernedMemory,
  type GovernedMemoryRecord,
  type GovernedMemoryStatus,
  type MemoryAuthority,
  type MemoryClass,
  type MemoryConflictStatus,
  type MemorySensitivity,
} from '../memory/governance';
import { estimateTokens } from './token-budget';
import {
  LAYER_BY_TYPE,
  typeRank,
  type CompiledContextPacket,
  type CompiledContextPacketV1,
  type CompiledContextPacketV2,
  type ContextExclusion,
  type ContextPacketItemV1,
  type ContextPacketItemV2,
  type ContextRequest,
  type ContextSelectionTier,
  type ContextStoreAdapter,
  type RenderedSteeringItem,
  type SteeringLayer,
  type SteeringRow,
} from './contract';

export const CONTEXT_COMPILER_V2_VERSION = 'context-compiler-v2.0';

const RATIONALE: Readonly<Record<SteeringLayer, string>> = {
  'firm-identity': 'Firm Soul/Compass: firm identity always steers firm-scoped drafting',
  'firm-playbook': 'Firm playbook: approved house drafting doctrine for deliverables',
  'user-voice': "Author's writing voice/profile (private, owner-scoped)",
  'client-steering': "Client soul/compass: approved framing for the active client only",
  'client-people': 'Client people roster: client-scoped principals and roles',
};

interface SectionUnit {
  label: string;
  body: string;
}

export function renderHumanSections(sections: unknown): string {
  return renderSectionUnits(sections, 'human')
    .map((unit) => unit.body)
    .join('\n');
}

export function renderAllSections(sections: unknown): string {
  return renderSectionUnits(sections, 'all')
    .map((unit) => unit.body)
    .join('\n');
}

function renderSectionUnits(sections: unknown, mode: 'human' | 'all'): SectionUnit[] {
  if (!Array.isArray(sections)) return [];
  const out: SectionUnit[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const raw = sections[index];
    if (!raw || typeof raw !== 'object') continue;
    const section = raw as { owner?: string; heading?: string; body?: string };
    if (mode === 'human' && section.owner !== 'human') continue;
    const body = typeof section.body === 'string' ? section.body.trim() : '';
    if (!body) continue;
    const heading = section.heading?.trim() || `section-${index + 1}`;
    out.push({ label: heading, body: mode === 'human' ? `${heading}: ${body}` : body });
  }
  return out;
}

export class ContextCompiler {
  constructor(private readonly store: ContextStoreAdapter) {}

  async compile(req: ContextRequest): Promise<CompiledContextPacket> {
    return req.contractVersion === 2 ? this.compileV2(req) : this.compileV1(req);
  }

  async compileV1(req: ContextRequest): Promise<CompiledContextPacketV1> {
    const rows = await this.store.loadSteeringRows(req);
    const wanted = new Set<SteeringLayer>(req.layers);
    const items: ContextPacketItemV1[] = [];
    const exclusions: ContextExclusion[] = [];
    const rendered: RenderedSteeringItem[] = [];
    const byLayer = groupRows(rows, wanted);
    const useTokens = req.budgetUnit === 'tokens';
    const cost = (body: string): number => (useTokens ? estimateTokens(body) : body.length);
    let budgetLeft = (useTokens ? req.tokenBudget : req.charBudget) ?? Number.POSITIVE_INFINITY;

    for (const layer of req.layers) {
      for (const row of byLayer.get(layer) ?? []) {
        const base = { layer, id: row.id, type: row.type, slug: row.slug };
        if (row.status === 'revoked' || row.status === 'superseded') {
          exclusions.push({ ...base, reason: row.status });
          continue;
        }
        if (row.expiresAt && dateMs(row.expiresAt) <= Date.now()) {
          exclusions.push({ ...base, reason: 'expired' });
          continue;
        }
        const units = renderSectionUnits(row.sections, req.render === 'all' ? 'all' : 'human');
        if (!units.length) {
          exclusions.push({ ...base, reason: 'empty' });
          continue;
        }
        const chosen = selectUnits(units, budgetLeft, cost);
        if (!chosen.selected.length) {
          exclusions.push({ ...base, reason: 'over-budget' });
          continue;
        }
        const body = chosen.selected.map((unit) => unit.body).join('\n');
        const contentHash = sha256(body);
        budgetLeft -= chosen.cost;
        items.push({
          ...base,
          chars: body.length,
          rationale: RATIONALE[layer],
          contentHash,
          ...(chosen.omitted.length ? { omittedSections: chosen.omitted } : {}),
        });
        rendered.push({ ...base, title: row.title ?? null, body, contentHash });
      }
    }

    const packet: CompiledContextPacketV1 = {
      packetId: randomUUID(),
      version: 1,
      surface: req.surface,
      tenantId: req.tenantId,
      effectiveTenantId: req.effectiveTenantId ?? req.tenantId,
      actorUserId: req.actorUserId ?? req.userId,
      userId: req.userId,
      clientId: req.clientId ?? null,
      ref: req.ref ?? {},
      items,
      exclusions,
      rendered,
      traceHash: sha256(
        stableStringify({
          version: 1,
          surface: req.surface,
          tenantId: req.tenantId,
          effectiveTenantId: req.effectiveTenantId ?? req.tenantId,
          userId: req.userId,
          clientId: req.clientId ?? null,
          ref: req.ref ?? {},
          items,
          exclusions,
          rendered,
        }),
      ),
      persisted: false,
      compiledAt: new Date().toISOString(),
    };
    await this.persist(req, packet);
    return packet;
  }

  async compileV2(req: ContextRequest): Promise<CompiledContextPacketV2> {
    const rows = this.store.loadGovernedSteeringRows
      ? await this.store.loadGovernedSteeringRows(req)
      : await this.store.loadSteeringRows(req);
    const wanted = new Set<SteeringLayer>(req.layers);
    const grouped = groupRows(rows, wanted);
    const selectedIds = new Set(req.selectedItemIds ?? []);
    const exclusions: ContextExclusion[] = [];
    const rendered: RenderedSteeringItem[] = [];
    const eligible: Array<{
      row: SteeringRow;
      layer: SteeringLayer;
      record: GovernedMemoryRecord;
      score: ReturnType<typeof scoreGovernedMemory>;
      tier: ContextSelectionTier;
    }> = [];
    const now = req.now ?? new Date();

    for (const layer of req.layers) {
      for (const row of grouped.get(layer) ?? []) {
        const record = governedRecord(row, req, selectedIds.has(row.id));
        const decision = filterGovernedMemory(record, {
          tenantId: req.effectiveTenantId ?? req.tenantId,
          userId: req.userId ?? '',
          clientId: req.clientId ?? null,
          ethicalWallAllowed: true,
          allowedSensitivities: req.allowedSensitivities ?? ['normal'],
          fourEyesEnabled: req.fourEyesEnabled ?? false,
          now,
        });
        if (!decision.include) {
          exclusions.push(exclusionFor(row, layer, suppressionToExclusion(decision.reason)));
          continue;
        }
        const tier = selectionTier(record);
        const score = scoreGovernedMemory({
          record,
          semanticSimilarity: record.explicitSelection ? 1 : 0.5,
          now,
        });
        eligible.push({ row, layer, record, score, tier });
      }
    }

    eligible.sort((a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      b.score.total - a.score.total ||
      compareSteeringRows(a.row, b.row),
    );

    const items: ContextPacketItemV2[] = [];
    const totalTokenBudget = req.tokenBudget ?? null;
    const charBudget = req.charBudget ?? Number.POSITIVE_INFINITY;
    let tokensLeft = totalTokenBudget ?? Number.POSITIVE_INFINITY;
    let charsLeft = charBudget;
    let truncated = false;

    for (const candidate of eligible) {
      const { row, layer, record, score, tier } = candidate;
      const units = renderSectionUnits(row.sections, req.render === 'all' ? 'all' : 'human');
      if (!units.length) {
        exclusions.push(exclusionFor(row, layer, 'empty'));
        continue;
      }
      const selected: SectionUnit[] = [];
      const omitted: string[] = [];
      let selectedTokens = 0;
      let selectedChars = 0;
      for (const unit of units) {
        const separator = selected.length ? '\n' : '';
        const value = `${separator}${unit.body}`;
        const tokenCost = estimateTokens(value);
        const charCost = value.length;
        if (tokenCost <= tokensLeft - selectedTokens && charCost <= charsLeft - selectedChars) {
          selected.push(unit);
          selectedTokens += tokenCost;
          selectedChars += charCost;
        } else {
          omitted.push(unit.label);
          truncated = true;
        }
      }
      if (!selected.length) {
        exclusions.push(exclusionFor(row, layer, 'over-budget'));
        truncated = true;
        continue;
      }
      const rawBody = selected.map((unit) => unit.body).join('\n');
      const contentHash = sha256(rawBody);
      const mayInstruct = instructionsAllowedFor(record);
      const body = typedContextBlock(record, row, rawBody, mayInstruct);
      tokensLeft -= selectedTokens;
      charsLeft -= selectedChars;
      items.push({
        layer,
        id: row.id,
        type: row.type,
        slug: row.slug,
        title: row.title ?? null,
        memoryClass: record.memoryClass,
        scope: record.scope,
        clientId: record.clientId ?? null,
        ownerUserId: record.ownerUserId ?? null,
        authority: record.authority,
        status: record.status,
        sourceType: record.sourceType,
        sourceId: record.sourceId ?? null,
        sourceRef: record.sourceRef ?? null,
        sourceContentHash: record.sourceContentHash ?? null,
        sourceVersion: record.sourceVersion ?? null,
        asOf: iso(record.asOf),
        effectiveFrom: iso(record.effectiveFrom),
        validUntil: iso(record.validUntil),
        lastConfirmedAt: iso(record.lastConfirmedAt),
        reviewDueAt: iso(row.reviewDueAt),
        humanApproved: Boolean(record.approvedByUserId && record.approvedAt),
        approvedByUserId: record.approvedByUserId ?? null,
        approvedAt: iso(record.approvedAt),
        secondApprovedByUserId: record.secondApprovedByUserId ?? null,
        secondApprovedAt: iso(record.secondApprovedAt),
        sensitivity: record.sensitivity ?? 'normal',
        instructionsAllowed: mayInstruct,
        includedSections: selected.map((unit) => unit.label),
        omittedSections: omitted,
        inclusionScore: score.total,
        inclusionReason: score.reason,
        selectionTier: tier,
        contentHash,
        chars: rawBody.length,
        tokens: selectedTokens,
        confidence: record.confidence ?? null,
        conflictStatus: record.conflictStatus ?? 'none',
        conflictGroupId: record.conflictGroupId ?? null,
        controllingItemId: record.controllingItemId ?? null,
        originSurface: record.originSurface ?? null,
        originTraceId: record.originTraceId ?? null,
        originContextPacketId: record.originContextPacketId ?? null,
        originModel: record.originModel ?? null,
        originPromptVersion: record.originPromptVersion ?? null,
      });
      rendered.push({
        layer,
        id: row.id,
        type: row.type,
        slug: row.slug,
        title: row.title ?? null,
        body,
        contentHash,
        instructionsAllowed: mayInstruct,
      });
    }

    const includedLayers = new Set(items.map((item) => item.layer));
    const missingRequiredLayers = req.layers.filter((layer) => !includedLayers.has(layer));
    const conflictCount = exclusions.filter((item) => item.reason === 'conflicted').length;
    const sourceFailureCount = exclusions.filter((item) =>
      ['source-missing', 'unavailable'].includes(item.reason),
    ).length;
    const healthReasons = [
      ...(missingRequiredLayers.length
        ? [`Missing required layers: ${missingRequiredLayers.join(', ')}`]
        : []),
      ...(conflictCount ? [`${conflictCount} unresolved conflict(s) withheld`] : []),
      ...(sourceFailureCount ? [`${sourceFailureCount} source failure(s)`] : []),
      ...(truncated ? ['Context budget truncated one or more items or sections'] : []),
    ];
    const healthStatus = conflictCount
      ? 'conflicted'
      : sourceFailureCount || missingRequiredLayers.length
        ? 'degraded'
        : truncated
          ? 'incomplete'
          : 'healthy';

    const stable = {
      version: 2,
      surface: req.surface,
      tenantId: req.tenantId,
      effectiveTenantId: req.effectiveTenantId ?? req.tenantId,
      actorUserId: req.actorUserId ?? req.userId,
      userId: req.userId,
      clientId: req.clientId ?? null,
      ref: req.ref ?? {},
      traceId: req.traceId ?? null,
      promptVersion: req.promptVersion ?? null,
      policyVersion: req.policyVersion ?? null,
      compilerVersion: req.compilerVersion ?? CONTEXT_COMPILER_V2_VERSION,
      requiredLayers: [...req.layers],
      items,
      exclusions,
      rendered: rendered.map(({ body: _body, ...metadata }) => metadata),
      totalTokenBudget,
      usedTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      truncated,
    };
    const packet: CompiledContextPacketV2 = {
      packetId: randomUUID(),
      version: 2,
      surface: req.surface,
      tenantId: req.tenantId,
      effectiveTenantId: req.effectiveTenantId ?? req.tenantId,
      actorUserId: req.actorUserId ?? req.userId,
      userId: req.userId,
      clientId: req.clientId ?? null,
      ref: req.ref ?? {},
      traceId: req.traceId ?? null,
      promptVersion: req.promptVersion ?? null,
      policyVersion: req.policyVersion ?? null,
      compilerVersion: req.compilerVersion ?? CONTEXT_COMPILER_V2_VERSION,
      requiredLayers: [...req.layers],
      health: {
        status: healthStatus,
        missingRequiredLayers,
        conflictCount,
        sourceFailureCount,
        reasons: healthReasons,
      },
      items,
      exclusions,
      rendered,
      totalTokenBudget,
      usedTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      truncated,
      incomplete: healthStatus !== 'healthy',
      traceHash: sha256(stableStringify(stable)),
      persisted: false,
      compiledAt: new Date().toISOString(),
    };
    await this.persist(req, packet);
    return packet;
  }

  private async persist(req: ContextRequest, packet: CompiledContextPacket): Promise<void> {
    if (!this.store.persistPacket) return;
    try {
      await this.store.persistPacket(packet);
      packet.persisted = true;
    } catch (error) {
      packet.persisted = false;
      if (req.persistence === 'required') throw error;
    }
  }
}

function groupRows(
  rows: SteeringRow[],
  wanted: Set<SteeringLayer>,
): Map<SteeringLayer, SteeringRow[]> {
  const byLayer = new Map<SteeringLayer, SteeringRow[]>();
  for (const row of rows) {
    const layer = LAYER_BY_TYPE[row.type];
    if (!layer || !wanted.has(layer)) continue;
    const bucket = byLayer.get(layer) ?? [];
    bucket.push(row);
    byLayer.set(layer, bucket);
  }
  for (const bucket of byLayer.values()) bucket.sort(compareSteeringRows);
  return byLayer;
}

function selectUnits(
  units: SectionUnit[],
  budgetLeft: number,
  cost: (body: string) => number,
): { selected: SectionUnit[]; omitted: string[]; cost: number } {
  const selected: SectionUnit[] = [];
  const omitted: string[] = [];
  let selectedCost = 0;
  for (const unit of units) {
    const separator = selected.length ? '\n' : '';
    const incremental = cost(`${separator}${unit.body}`);
    if (incremental <= budgetLeft - selectedCost) {
      selected.push(unit);
      selectedCost += incremental;
    } else {
      omitted.push(unit.label);
    }
  }
  return { selected, omitted, cost: selectedCost };
}

function governedRecord(
  row: SteeringRow,
  req: ContextRequest,
  explicitSelection: boolean,
): GovernedMemoryRecord {
  const legacy = classifyLegacyMemory({
    type: row.type,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    clientId: row.clientId,
    provenance: row.authority,
    slug: row.slug,
    expiresAt: row.expiresAt,
  });
  const memoryClass = isMemoryClass(row.memoryClass) ? row.memoryClass : legacy.memoryClass;
  const authority = isAuthority(row.governedAuthority)
    ? row.governedAuthority
    : legacy.authority;
  const status = isStatus(row.status)
    ? row.status
    : legacy.status;
  const scope = row.clientId
    ? 'client'
    : row.visibility === 'user' || row.ownerUserId
      ? 'user_private'
      : 'firm';
  const sourceType = row.sourceType ?? sourceTypeFor(row.type);
  return {
    id: row.id,
    tenantId: req.effectiveTenantId ?? req.tenantId,
    clientId: row.clientId,
    ownerUserId: row.ownerUserId,
    memoryClass,
    authority,
    scope,
    status,
    sourceType: sourceType as GovernedMemoryRecord['sourceType'],
    sourceId: row.sourceId,
    sourceRef: row.sourceRef,
    sourceContentHash: row.sourceContentHash,
    sourceVersion: row.sourceVersion,
    assertedByUserId: row.assertedByUserId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    secondApprovedByUserId: row.secondApprovedByUserId,
    secondApprovedAt: row.secondApprovedAt,
    asOf: row.asOf,
    effectiveFrom: row.effectiveFrom,
    validUntil: row.validUntil,
    lastConfirmedAt: row.confirmedAt,
    reviewDueAt: row.reviewDueAt,
    expiresAt: row.expiresAt,
    confidence: row.confidence,
    conflictStatus: isConflict(row.conflictStatus) ? row.conflictStatus : 'none',
    conflictGroupId: row.conflictGroupId,
    controllingItemId: row.controllingItemId,
    sensitivity: isSensitivity(row.sensitivity) ? row.sensitivity : 'normal',
    instructionsAllowed: row.instructionsAllowed ?? false,
    explicitSelection,
    originSurface: row.originSurface,
    originTraceId: row.originTraceId,
    originContextPacketId: row.originContextPacketId,
    originModel: row.originModel,
    originPromptVersion: row.originPromptVersion,
  };
}

/**
 * Reasons that mean "the caller isn't authorized to know this item exists,"
 * as opposed to lifecycle/content reasons where the caller already has
 * legitimate visibility into the item. Only the latter may carry id/type/slug.
 */
const IDENTITY_WITHHELD_REASONS: ReadonlySet<ContextExclusion['reason']> = new Set([
  'unauthorized',
  'wrong-client',
  'sensitivity-denied',
]);

function exclusionFor(
  row: SteeringRow,
  layer: SteeringLayer,
  reason: ContextExclusion['reason'],
): ContextExclusion {
  if (IDENTITY_WITHHELD_REASONS.has(reason)) return { layer, reason };
  return { layer, id: row.id, type: row.type, slug: row.slug, reason };
}

function suppressionToExclusion(reason: string): ContextExclusion['reason'] {
  const map: Record<string, ContextExclusion['reason']> = {
    wrong_tenant: 'unauthorized',
    wrong_user: 'unauthorized',
    wrong_client: 'wrong-client',
    ethical_wall: 'unauthorized',
    inactive_status: 'revoked',
    invalid_until: 'invalid-until',
    unapproved: 'unapproved',
    sensitivity_denied: 'sensitivity-denied',
    conflict_unresolved: 'conflicted',
    ttl_required: 'expired',
    source_missing: 'source-missing',
    legacy_unclassified: 'legacy-unclassified',
  };
  return map[reason] ?? 'unavailable';
}

function selectionTier(record: GovernedMemoryRecord): ContextSelectionTier {
  if (record.explicitSelection) return 'explicit';
  if (['institutional_authoritative', 'client_steering'].includes(record.memoryClass)) {
    return 'authoritative_policy';
  }
  if (record.authority === 'external_authoritative') return 'system_of_record';
  if (record.lastConfirmedAt || record.approvedAt) return 'human_confirmed';
  if (['analyst_verified', 'user_asserted'].includes(record.authority)) {
    return 'source_backed_derived';
  }
  return 'episodic_inferred';
}

function tierRank(tier: ContextSelectionTier): number {
  return [
    'explicit',
    'authoritative_policy',
    'system_of_record',
    'human_confirmed',
    'source_backed_derived',
    'episodic_inferred',
  ].indexOf(tier);
}

function typedContextBlock(
  record: GovernedMemoryRecord,
  row: SteeringRow,
  body: string,
  instructionsAllowed: boolean,
): string {
  const attributes = [
    `source_type=${JSON.stringify(record.sourceType)}`,
    `source_id=${JSON.stringify(record.sourceId ?? row.id)}`,
    `memory_class=${JSON.stringify(record.memoryClass)}`,
    `authority=${JSON.stringify(record.authority)}`,
    `scope=${JSON.stringify(record.scope)}`,
    `client_id=${JSON.stringify(record.clientId ?? '')}`,
    `as_of=${JSON.stringify(iso(record.asOf) ?? '')}`,
    `instructions_allowed=${JSON.stringify(instructionsAllowed)}`,
  ].join(' ');
  return `<context_item ${attributes}>\n${body}\n</context_item>`;
}

function compareSteeringRows(a: SteeringRow, b: SteeringRow): number {
  return (
    typeRank(a.type) - typeRank(b.type) ||
    statusRank(a.status) - statusRank(b.status) ||
    compareNullableText(a.governedAuthority ?? a.authority, b.governedAuthority ?? b.authority) ||
    compareDateDesc(a.confirmedAt, b.confirmedAt) ||
    compareDateDesc(a.updatedAt, b.updatedAt) ||
    a.type.localeCompare(b.type) ||
    a.slug.localeCompare(b.slug) ||
    a.id.localeCompare(b.id)
  );
}

function statusRank(status: string): number {
  if (status === 'active') return 0;
  if (status === 'stale') return 1;
  if (status === 'conflicted') return 2;
  if (status === 'pending_review' || status === 'suggested') return 3;
  if (status === 'superseded') return 4;
  if (status === 'revoked' || status === 'rejected' || status === 'expired') return 5;
  return 6;
}

function sourceTypeFor(type: string): string {
  if (type === 'playbook') return 'firm_playbook';
  if (type.startsWith('firm-')) return 'firm_playbook';
  if (type.startsWith('client-')) return 'client_record';
  if (type.startsWith('user-')) return 'user_message';
  return 'unknown';
}

function isMemoryClass(value: unknown): value is MemoryClass {
  return [
    'institutional_authoritative',
    'client_steering',
    'user_preference',
    'episodic_working',
    'legacy_unclassified',
  ].includes(String(value));
}

function isAuthority(value: unknown): value is MemoryAuthority {
  return [
    'firm_approved',
    'client_approved',
    'external_authoritative',
    'user_asserted',
    'analyst_verified',
    'working_draft',
    'model_inferred',
    'legacy_unclassified',
  ].includes(String(value));
}

function isStatus(value: unknown): value is GovernedMemoryStatus {
  return [
    'suggested',
    'pending_review',
    'active',
    'stale',
    'conflicted',
    'superseded',
    'revoked',
    'rejected',
    'expired',
  ].includes(String(value));
}

function isConflict(value: unknown): value is MemoryConflictStatus {
  return ['none', 'open', 'resolved', 'controlling'].includes(String(value));
}

function isSensitivity(value: unknown): value is MemorySensitivity {
  return ['normal', 'confidential', 'restricted'].includes(String(value));
}

function compareNullableText(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

function compareDateDesc(
  a: string | Date | null | undefined,
  b: string | Date | null | undefined,
): number {
  const left = a ? dateMs(a) : 0;
  const right = b ? dateMs(b) : 0;
  return right - left;
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function renderedBody(packet: CompiledContextPacket, type: string): string | undefined {
  return packet.rendered.find((item) => item.type === type)?.body;
}

export function renderedLayer(
  packet: CompiledContextPacket,
  layer: SteeringLayer,
): RenderedSteeringItem[] {
  return packet.rendered.filter((item) => item.layer === layer);
}
