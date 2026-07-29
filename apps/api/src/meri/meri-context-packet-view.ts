import type { Prisma } from '@prisma/client';
import type { MeriContextPacketSummary } from '@capiro/meriv2-core';

interface StoredItem {
  id?: unknown;
  type?: unknown;
  layer?: unknown;
  rationale?: unknown;
}

interface StoredExclusion {
  id?: unknown;
  type?: unknown;
  reason?: unknown;
}

function array(value: Prisma.JsonValue | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function contextPacketView(row: {
  id: string;
  surface: string;
  clientId: string | null;
  items: Prisma.JsonValue;
  exclusions: Prisma.JsonValue;
  createdAt: Date;
}): MeriContextPacketSummary {
  const storedItems = array(row.items).filter(
    (value): value is StoredItem => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
  );
  const storedExclusions = array(row.exclusions).filter(
    (value): value is StoredExclusion => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
  );
  const unauthorized = storedExclusions.filter((item) => item.reason === 'unauthorized');
  return {
    packetId: row.id,
    compiledAt: row.createdAt.toISOString(),
    surface: row.surface,
    clientId: row.clientId,
    items: storedItems
      .filter((item) => typeof item.id === 'string' && typeof item.type === 'string')
      .map((item) => {
        const layer = typeof item.layer === 'string' ? item.layer : '';
        const scope = layer === 'user-voice' ? 'personal' : layer.startsWith('client-') ? 'client' : 'firm';
        return {
          id: String(item.id),
          label: String(item.type),
          type: String(item.type),
          scope,
          authority: 'human-authored',
          userScoped: scope === 'personal',
          rationale: typeof item.rationale === 'string' ? item.rationale : null,
          selection: 'automatic',
        };
      }),
    exclusions: storedExclusions
      .filter(
        (item) =>
          item.reason !== 'unauthorized' &&
          typeof item.reason === 'string' &&
          typeof item.type === 'string',
      )
      .map((item) => ({
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        label: String(item.type),
        type: String(item.type),
        reason: String(item.reason),
      })),
    unauthorizedCount: unauthorized.length,
    degraded: false,
  };
}
