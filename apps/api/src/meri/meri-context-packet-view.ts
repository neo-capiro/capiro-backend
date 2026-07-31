import type { Prisma } from '@prisma/client';
import type { MeriContextAuthority, MeriContextPacketSummary } from '@capiro/meriv2-core';

const AUTHORITIES: ReadonlySet<string> = new Set<MeriContextAuthority>([
  'human-authored',
  'system-of-record',
  'derived',
  'unknown',
  'firm_approved',
  'client_approved',
  'external_authoritative',
  'user_asserted',
  'analyst_verified',
  'working_draft',
  'model_inferred',
  'legacy_unclassified',
]);

function authorityOf(value: unknown): MeriContextAuthority | null {
  return typeof value === 'string' && AUTHORITIES.has(value)
    ? (value as MeriContextAuthority)
    : typeof value === 'string' && value.trim()
      ? 'unknown'
      : null;
}

interface StoredItem {
  id?: unknown;
  type?: unknown;
  layer?: unknown;
  rationale?: unknown;
  authority?: unknown;
  status?: unknown;
  legacyStatus?: unknown;
  selectionTier?: unknown;
  inclusionReason?: unknown;
  scope?: unknown;
  asOf?: unknown;
  lastConfirmedAt?: unknown;
  title?: unknown;
}

interface StoredExclusion {
  id?: unknown;
  type?: unknown;
  reason?: unknown;
}

const IDENTITY_WITHHELD_REASONS: ReadonlySet<string> = new Set([
  'unauthorized',
  'wrong-client',
  'sensitivity-denied',
]);

function array(value: Prisma.JsonValue | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export interface ContextPacketV2Columns {
  packetVersion?: number | null;
  health?: Prisma.JsonValue | null;
  traceId?: string | null;
  requiredLayers?: string[] | null;
  usedTokens?: number | null;
  totalTokenBudget?: number | null;
  truncated?: boolean | null;
  incomplete?: boolean | null;
}

export function contextPacketView(
  row: {
    id: string;
    surface: string;
    clientId: string | null;
    items: Prisma.JsonValue;
    exclusions: Prisma.JsonValue;
    createdAt: Date;
  } & ContextPacketV2Columns,
  clientName: string | null = null,
): MeriContextPacketSummary {
  const storedItems = array(row.items).filter((value): value is StoredItem => isRecord(value));
  const storedExclusions = array(row.exclusions).filter((value): value is StoredExclusion =>
    isRecord(value),
  );
  const withheld = storedExclusions.filter(
    (item) => typeof item.reason === 'string' && IDENTITY_WITHHELD_REASONS.has(item.reason),
  );
  const health = isRecord(row.health) ? row.health : null;
  const healthStatus = health && typeof health.status === 'string' ? health.status : null;
  const degraded = row.packetVersion === 2 && healthStatus !== null && healthStatus !== 'healthy';
  const healthReasons =
    health && Array.isArray(health.reasons)
      ? health.reasons.filter((reason): reason is string => typeof reason === 'string')
      : [];

  return {
    // This view can only be built from a row that was retrieved from context_packet.
    packetId: row.id,
    persisted: true,
    persistenceErrorCode: null,
    compiledAt: row.createdAt.toISOString(),
    surface: row.surface,
    clientId: row.clientId,
    items: storedItems
      .filter((item) => typeof item.id === 'string' && typeof item.type === 'string')
      .map((item) => {
        const layer = typeof item.layer === 'string' ? item.layer : '';
        const scope =
          text(item.scope) === 'user_private'
            ? 'personal'
            : text(item.scope) === 'client'
              ? 'client'
              : text(item.scope) === 'firm'
                ? 'firm'
                : layer === 'user-voice'
                  ? 'personal'
                  : layer.startsWith('client-')
                    ? 'client'
                    : 'firm';
        return {
          id: String(item.id),
          label: text(item.title) ?? String(item.type),
          type: String(item.type),
          scope,
          authority: authorityOf(item.authority) ?? 'human-authored',
          ...(text(item.status) ? { status: String(item.status) } : {}),
          ...(scope === 'client' && clientName ? { clientName } : {}),
          userScoped: scope === 'personal',
          rationale: text(item.rationale) ?? text(item.inclusionReason),
          selection: text(item.selectionTier) === 'explicit' ? 'explicit' : 'automatic',
          ...(text(item.asOf) ? { asOf: String(item.asOf) } : {}),
          ...(text(item.lastConfirmedAt) ? { lastConfirmedAt: String(item.lastConfirmedAt) } : {}),
        };
      }),
    exclusions: storedExclusions
      .filter(
        (item) =>
          typeof item.reason === 'string' &&
          !IDENTITY_WITHHELD_REASONS.has(item.reason) &&
          typeof item.type === 'string',
      )
      .map((item) => ({
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        label: String(item.type),
        type: String(item.type),
        reason: String(item.reason),
      })),
    unauthorizedCount: withheld.length,
    degraded,
    ...(degraded && healthReasons.length ? { degradedReason: healthReasons.join('; ') } : {}),
  };
}
