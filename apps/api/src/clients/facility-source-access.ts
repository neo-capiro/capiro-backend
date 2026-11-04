import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { assertSharedProfileEvidence } from './profile-shared-evidence.js';

async function visibleEvidence(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  value: unknown,
) {
  const evidence: unknown[] = [];
  let unavailable = false;
  for (const entry of Array.isArray(value) ? value : []) {
    try {
      await assertSharedProfileEvidence(
        tx,
        ctx.tenantId,
        { kind: 'client', id: clientId },
        [entry],
        ctx,
      );
      evidence.push(entry);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      unavailable = true;
    }
  }
  return { evidence, unavailable };
}

function impactRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function impactValues(value: Record<string, unknown>) {
  const {
    evidence: _evidence,
    history: _history,
    sourceUnavailable: _unavailable,
    ...values
  } = value;
  return values;
}

async function visibleImpact(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  impact: Record<string, unknown>,
) {
  const sources = await visibleEvidence(tx, ctx, clientId, impact.evidence);
  const { history: _history, ...current } = impact;
  const history = [];
  for (const raw of Array.isArray(impact.history) ? impact.history : []) {
    const entry = impactRecord(raw);
    if (!entry) continue;
    const previousSources = await visibleEvidence(tx, ctx, clientId, entry.evidence);
    history.push({
      ...impactValues(entry),
      evidence: previousSources.evidence,
      ...(previousSources.unavailable || entry.sourceUnavailable === true
        ? { sourceUnavailable: true }
        : {}),
    });
  }
  return {
    ...current,
    ...(sources.unavailable ? { evidence: sources.evidence, sourceUnavailable: true } : {}),
    ...(Array.isArray(impact.history) ? { history } : {}),
  };
}

/** Accepted facility values survive source withdrawal; document excerpts do not. */
export async function visibleFacilitySources<
  T extends { sourceEvidence?: unknown; economicImpact?: unknown },
>(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  facility: T,
): Promise<T & { sourceEvidenceUnavailable?: boolean }> {
  const sources = await visibleEvidence(tx, ctx, clientId, facility.sourceEvidence);
  const impact = impactRecord(facility.economicImpact);
  return {
    ...facility,
    ...(sources.unavailable
      ? { sourceEvidence: sources.evidence, sourceEvidenceUnavailable: true }
      : {}),
    ...(impact ? { economicImpact: await visibleImpact(tx, ctx, clientId, impact) } : {}),
  } as T & { sourceEvidenceUnavailable?: boolean };
}

/** A redacted read must not let an unrelated edit erase hidden source history. */
export async function preserveUnavailableFacilityEvidence(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  stored: Prisma.JsonValue,
  incoming: unknown[],
): Promise<Prisma.InputJsonValue> {
  const visible = await visibleEvidence(tx, ctx, clientId, stored);
  const visibleKeys = new Set(visible.evidence.map((entry) => JSON.stringify(entry)));
  const hidden = (Array.isArray(stored) ? stored : []).filter(
    (entry) => !visibleKeys.has(JSON.stringify(entry)),
  );
  return [
    ...new Map([...hidden, ...incoming].map((entry) => [JSON.stringify(entry), entry])).values(),
  ] as Prisma.InputJsonValue;
}

/** Old citations remain tied to their old values when a person changes an impact claim. */
export async function preserveFacilityImpactHistory(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  stored: Prisma.JsonValue,
  incoming: Record<string, unknown>,
): Promise<Prisma.InputJsonValue> {
  const previous = impactRecord(stored);
  const values = impactValues(incoming);
  const evidence = Array.isArray(incoming.evidence) ? incoming.evidence : [];
  const history = previous && Array.isArray(previous.history) ? previous.history : [];
  if (previous && isDeepStrictEqual(impactValues(previous), values)) {
    const merged = await preserveUnavailableFacilityEvidence(
      tx,
      ctx,
      clientId,
      previous.evidence as Prisma.JsonValue,
      evidence,
    );
    return JSON.parse(
      JSON.stringify({ ...values, evidence: merged, ...(history.length ? { history } : {}) }),
    ) as Prisma.InputJsonValue;
  }
  const previousSnapshot = previous
    ? { ...impactValues(previous), evidence: previous.evidence ?? [] }
    : null;
  return JSON.parse(
    JSON.stringify({
      ...values,
      evidence,
      ...(previousSnapshot ? { history: [...history, previousSnapshot] } : {}),
    }),
  ) as Prisma.InputJsonValue;
}
