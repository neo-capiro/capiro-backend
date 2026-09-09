/** Public scope receipt for one completed turn. Stored in existing message metadata. */
export interface MeriTurnScope {
  kind: 'client' | 'portfolio' | 'external_entity' | 'general' | 'unknown';
  clientId: string | null;
  clientName: string | null;
  targetHint: string | null;
}

/** The conversation is the server snapshot captured before dispatch, never re-read at completion. */
export function captureMeriTurnScope(
  conversation: { clientId: string | null; client?: { id: string; name: string } | null },
  retrieval?: { plan?: { subjectScope?: string; targetHint?: string | null } } | null,
  packet?: { clientId?: string | null } | null,
): MeriTurnScope {
  const empty: MeriTurnScope = { kind: 'unknown', clientId: null, clientName: null, targetHint: null };
  const kind = retrieval?.plan?.subjectScope;
  if (kind === 'portfolio' || kind === 'general') return { ...empty, kind };
  if (kind === 'external_entity') {
    return { ...empty, kind, targetHint: retrieval?.plan?.targetHint?.trim() || null };
  }
  if (kind !== 'client') return empty;
  // A compiled packet is authoritative when present, including an explicit
  // null client. Do not substitute the picker if compilation disagreed.
  const clientId = packet && Object.hasOwn(packet, 'clientId')
    ? packet.clientId || null
    : conversation.clientId;
  if (!clientId) return empty;
  return {
    ...empty,
    kind,
    clientId,
    clientName: conversation.client?.id === clientId ? conversation.client.name : null,
  };
}
