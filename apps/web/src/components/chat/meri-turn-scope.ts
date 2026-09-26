import type { ChatMessage } from './chat-store.js';

/** Immutable turn context. This describes retrieval scope, not ownership of each source. */
export interface MeriTurnScope {
  kind: 'client' | 'portfolio' | 'external_entity' | 'general' | 'prospect' | 'unknown';
  clientId: string | null;
  clientName: string | null;
  targetHint: string | null;
  // Phase 4 prospect receipt: bounded identity captured server-side. Nullable
  // where a prospect may lack a linked organization/client.
  prospectId?: string;
  prospectName?: string;
  canonicalOrganizationId?: string | null;
  linkedClientId?: string | null;
  scopeVersion?: string;
}

const UNKNOWN_SCOPE: MeriTurnScope = {
  kind: 'unknown', clientId: null, clientName: null, targetHint: null,
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export function readMeriTurnScope(value: unknown): MeriTurnScope | undefined {
  const row = record(value);
  if (!row) return undefined;
  if (row.kind === 'client' && text(row.clientId)) {
    return { ...UNKNOWN_SCOPE, kind: 'client', clientId: text(row.clientId), clientName: text(row.clientName) };
  }
  if (row.kind === 'prospect'
    && text(row.prospectId)
    && text(row.prospectName)
    && text(row.scopeVersion)) {
    // Accept a prospect receipt only when the required ids/name/version are
    // valid; preserve nullable identity/client ids as recorded.
    const uuid = (value: unknown): string | null => {
      const candidate = text(value);
      return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
    };
    if (!uuid(row.prospectId)) return undefined;
    if ((text(row.prospectName)?.length ?? 0) > 200) return undefined;
    if (!text(row.scopeVersion)?.length || !/^[0-9a-f]{64}$/.test(text(row.scopeVersion) as string)) return undefined;
    const canonical = uuid(row.canonicalOrganizationId);
    const linked = uuid(row.linkedClientId);
    if (canonical === null && row.canonicalOrganizationId != null) return undefined;
    if (linked === null && row.linkedClientId != null) return undefined;
    return {
      ...UNKNOWN_SCOPE,
      kind: 'prospect',
      prospectId: text(row.prospectId) as string,
      prospectName: text(row.prospectName) as string,
      canonicalOrganizationId: canonical,
      linkedClientId: linked,
      scopeVersion: text(row.scopeVersion) as string,
    };
  }
  if (row.kind === 'external_entity') return { ...UNKNOWN_SCOPE, kind: 'external_entity', targetHint: text(row.targetHint) };
  if (row.kind === 'portfolio' || row.kind === 'general' || row.kind === 'unknown') {
    return { ...UNKNOWN_SCOPE, kind: row.kind };
  }
  return undefined;
}

/** Restore existing metadata without ever consulting the conversation's current client. */
export function persistedMeriTurnScope(message: { clientId?: unknown; metadata?: Record<string, unknown> | null }): MeriTurnScope {
  const meta = message.metadata ?? {};
  const captured = readMeriTurnScope(meta.turnScope);
  if (captured) return captured;
  const plan = record(record(meta.retrieval)?.plan);
  const kind = plan?.subjectScope;
  if (kind === 'portfolio' || kind === 'general') return { ...UNKNOWN_SCOPE, kind };
  if (kind === 'external_entity') return { ...UNKNOWN_SCOPE, kind, targetHint: text(plan?.targetHint) };
  if (kind === 'client') {
    const packet = record(meta.contextPacket);
    const clientId = packet && Object.hasOwn(packet, 'clientId') ? text(packet.clientId) : text(message.clientId);
    if (clientId) return { ...UNKNOWN_SCOPE, kind, clientId };
  }
  return { ...UNKNOWN_SCOPE };
}

export function messageMeriTurnScope(message: Pick<ChatMessage, 'turnScope' | 'retrieval'>): MeriTurnScope {
  return readMeriTurnScope(message.turnScope) ?? persistedMeriTurnScope({ metadata: { retrieval: message.retrieval } });
}

export function meriTurnScopeLabel(scope?: MeriTurnScope | null, clients: Array<{ id: string; name: string }> = []): string {
  if (scope?.kind === 'client' && scope.clientId) {
    return scope.clientName || clients.find((client) => client.id === scope.clientId)?.name || `Client · ${scope.clientId}`;
  }
  if (scope?.kind === 'portfolio') return 'Portfolio — all clients';
  if (scope?.kind === 'prospect') return scope.prospectName ? `Prospect · ${scope.prospectName}` : 'Prospect';
  if (scope?.kind === 'external_entity') return scope.targetHint ? `External subject · ${scope.targetHint}` : 'External subject — name not recorded';
  if (scope?.kind === 'general') return 'General';
  return 'Scope not recorded';
}

export function meriPacketScopeLabel(
  packet: { clientId?: string | null; items?: Array<{ scope: string; clientName?: string }> } | null,
  clients: Array<{ id: string; name: string }> = [],
): string {
  if (packet?.clientId) {
    const clientName = packet.items?.find((item) => item.scope === 'client' && item.clientName)?.clientName ?? null;
    return meriTurnScopeLabel({ ...UNKNOWN_SCOPE, kind: 'client', clientId: packet.clientId, clientName }, clients);
  }
  return packet && Object.hasOwn(packet, 'clientId') ? 'Firm / personal context' : 'Scope not recorded';
}
