import type { ChatMessage } from './chat-store.js';

/** Immutable turn context. This describes retrieval scope, not ownership of each source. */
export interface MeriTurnScope {
  kind: 'client' | 'portfolio' | 'external_entity' | 'general' | 'unknown';
  clientId: string | null;
  clientName: string | null;
  targetHint: string | null;
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
