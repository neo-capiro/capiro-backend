import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { asString } from './client-profile-fill.helpers.js';

export interface AdvancedFindingRow {
  id: string;
  kind: string;
  targetKey: string;
  source: string;
  factKind: string;
  currentValue: unknown;
  proposedValue: unknown;
  evidence: unknown;
  confidence: number | string;
  status: string;
  contentHash: string;
}

export interface FindingApplicationReporter {
  warn(message: string): void;
  safeError(error: unknown): string;
}

export async function auditAdvanced(
  tx: any,
  ctx: TenantContext,
  clientId: string,
  finding: AdvancedFindingRow,
  before: unknown,
  after: unknown,
) {
  await tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: (ctx as unknown as { role?: string }).role ?? null,
      action: 'client_profile_fill.apply',
      entityType: `client_profile_fill:${finding.kind}`,
      entityId: clientId,
      before: { findingId: finding.id, value: jsonSafe(before) } as any,
      after: {
        findingId: finding.id,
        targetKey: finding.targetKey,
        source: finding.source,
        value: jsonSafe(after),
      } as any,
    },
  });
}

export function requiredString(value: unknown, label: string): string {
  const text = asString(value);
  if (!text) throw new BadRequestException(`${label} is required`);
  return text;
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
