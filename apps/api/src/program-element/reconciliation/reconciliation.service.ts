import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeMoneyToMillions } from '@capiro/shared/money';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  authorityForSource,
  mayOwnCanonicalField,
  type CanonicalPeYearField,
  type PeSourceAuthority,
} from '../program-element-field-ownership.js';
import { sourceRank } from '../source-priority.js';
import type { PeYearWriteContext } from '../types.js';

export const RECONCILE_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
export type ReconcileField = (typeof RECONCILE_FIELDS)[number];

const DELTA_THRESHOLD = 0.1;

type ReconciliationClient = Pick<
  Prisma.TransactionClient,
  'programElementYearSourceValue' | 'reconciliationReviewQueue'
>;

export interface ReconcileInput {
  peCode: string;
  fy: number;
  source: string;
  authority: PeSourceAuthority;
  values: Partial<Record<ReconcileField, number | null>>;
  currentValues: Partial<Record<ReconcileField, number | null>>;
  context?: PeYearWriteContext;
}

export interface FieldReconcileResult {
  fieldName: ReconcileField;
  observationId: string;
  observationKey: string;
  canonicalValueM: number;
  mayOwn: boolean;
  shouldWin: boolean;
  queued: boolean;
  conflictType: 'value_conflict' | 'unauthorized_field_source' | null;
  deltaPct: number | null;
  reason?: 'enacted_conflict' | 'over_threshold' | 'manual_override_protected';
}

export function relativeDelta(a: number, b: number): number {
  if (a === b) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

export function shouldQueue(
  fieldName: string,
  canonical: number | null,
  incoming: number | null,
): { queued: boolean; deltaPct: number | null; reason?: 'enacted_conflict' | 'over_threshold' } {
  if (incoming === null || canonical === null) return { queued: false, deltaPct: null };
  if (canonical === incoming) return { queued: false, deltaPct: 0 };

  const delta = relativeDelta(canonical, incoming);
  if (fieldName === 'enacted') {
    return { queued: true, deltaPct: delta, reason: 'enacted_conflict' };
  }
  if (delta > DELTA_THRESHOLD) {
    return { queued: true, deltaPct: delta, reason: 'over_threshold' };
  }
  return { queued: false, deltaPct: delta };
}

function stableNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Observation value must be finite: ${String(value)}`);
  return new Prisma.Decimal(Object.is(value, -0) ? 0 : value).toString();
}

export function buildObservationKey(input: {
  sourceDocumentId?: string | null;
  source: string;
  parseJobId?: string | null;
  peCode: string;
  fy: number;
  fieldName: ReconcileField;
  originalValue: number;
  originalUnit: string;
  canonicalValueM: number;
  pageNumber?: number | null;
  sourceSpanHash?: string | null;
  extractorVersion?: string | null;
}): string {
  const tuple = [
    input.sourceDocumentId ?? input.source,
    input.parseJobId ?? '',
    input.peCode,
    input.fy,
    input.fieldName,
    stableNumber(input.originalValue),
    input.originalUnit,
    stableNumber(input.canonicalValueM),
    input.pageNumber ?? '',
    input.sourceSpanHash ?? '',
    input.extractorVersion ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reconcile(
    input: ReconcileInput,
    client: ReconciliationClient = this.prisma as unknown as ReconciliationClient,
  ): Promise<FieldReconcileResult[]> {
    const results: FieldReconcileResult[] = [];

    for (const fieldName of RECONCILE_FIELDS) {
      const incoming = input.values[fieldName] ?? null;
      if (incoming === null) continue;
      if (!Number.isFinite(incoming)) {
        throw new TypeError(`${input.peCode} FY${input.fy} ${fieldName} must be finite`);
      }

      const original = input.context?.originalValues?.[fieldName] ?? {
        value: incoming,
        unit: 'millions' as const,
      };
      const normalized = normalizeMoneyToMillions(original.value, original.unit).valueM;
      if (Math.abs(normalized - incoming) > 0.000001) {
        throw new Error(
          `Original-value provenance does not normalize to canonical value for ${input.peCode} FY${input.fy} ${fieldName}: original=${original.value} ${original.unit} normalized=${normalized} canonical=${incoming}`,
        );
      }

      const observationKey = buildObservationKey({
        sourceDocumentId: input.context?.sourceDocumentId,
        source: input.source,
        parseJobId: input.context?.parseJobId,
        peCode: input.peCode,
        fy: input.fy,
        fieldName,
        originalValue: original.value,
        originalUnit: original.unit,
        canonicalValueM: incoming,
        pageNumber: input.context?.pageNumber,
        sourceSpanHash: input.context?.sourceSpanHash,
        extractorVersion: input.context?.extractorVersion,
      });
      const observedAt = new Date();
      const observation = await client.programElementYearSourceValue.upsert({
        where: { observationKey },
        create: {
          peCode: input.peCode,
          fy: input.fy,
          fieldName,
          source: input.source,
          valueJsonb: {
            canonicalValueM: incoming,
            originalValue: original.value,
            originalUnit: original.unit,
          },
          valueDecimal: incoming,
          canonicalValueM: incoming,
          originalValueDecimal: original.value,
          originalUnit: original.unit,
          sourceDocumentId: input.context?.sourceDocumentId ?? null,
          parseJobId: input.context?.parseJobId ?? null,
          pageNumber: input.context?.pageNumber ?? null,
          sourceSpanHash: input.context?.sourceSpanHash ?? null,
          extractorVersion: input.context?.extractorVersion ?? null,
          observationKey,
          isWinner: false,
          lastObservedAt: observedAt,
          observationCount: 1,
        },
        update: {
          lastObservedAt: observedAt,
          observationCount: { increment: 1 },
          sourceDocumentId: input.context?.sourceDocumentId ?? undefined,
          parseJobId: input.context?.parseJobId ?? undefined,
          pageNumber: input.context?.pageNumber ?? undefined,
          sourceSpanHash: input.context?.sourceSpanHash ?? undefined,
          extractorVersion: input.context?.extractorVersion ?? undefined,
        },
        select: {
          id: true,
          source: true,
          sourceDocumentId: true,
          isWinner: true,
        },
      });

      const currentWinner = await client.programElementYearSourceValue.findFirst({
        where: {
          peCode: input.peCode,
          fy: input.fy,
          fieldName,
          isWinner: true,
        },
        orderBy: { lastObservedAt: 'desc' },
        select: { id: true, source: true, sourceDocumentId: true, observationKey: true },
      });
      const incomingAuthority = input.authority ?? authorityForSource(input.source);
      const mayOwn = mayOwnCanonicalField(incomingAuthority, fieldName);
      const currentAuthority = currentWinner ? authorityForSource(currentWinner.source) : 'unknown';
      const manualOverrideProtected =
        currentAuthority === 'manual_override' && incomingAuthority !== 'manual_override';
      const sameAuthorityTieBreakAllows =
        !currentWinner ||
        currentAuthority !== incomingAuthority ||
        sourceRank(input.source) <= sourceRank(currentWinner.source);
      const shouldWin = mayOwn && !manualOverrideProtected && sameAuthorityTieBreakAllows;
      const canonicalValue = input.currentValues[fieldName] ?? null;
      const decision = shouldQueue(fieldName, canonicalValue, incoming);

      let conflictType: FieldReconcileResult['conflictType'] = null;
      let reason: FieldReconcileResult['reason'] = decision.reason;
      if (!mayOwn) conflictType = 'unauthorized_field_source';
      else if (manualOverrideProtected) {
        conflictType = 'value_conflict';
        reason = 'manual_override_protected';
      } else if (decision.queued && incomingAuthority !== 'manual_override') {
        conflictType = 'value_conflict';
      }

      const reviewConflictType =
        incomingAuthority !== 'manual_override' ? conflictType : null;
      const queued = reviewConflictType !== null;
      if (reviewConflictType) {
        const existingOpen = await client.reconciliationReviewQueue.findFirst({
          where: {
            peCode: input.peCode,
            fy: input.fy,
            fieldName,
            conflictingSource: input.source,
            conflictType: reviewConflictType,
            status: 'open',
          },
          select: { id: true },
        });
        const reviewData = {
          currentValue: canonicalValue === null ? null : stableNumber(canonicalValue),
          currentSource: currentWinner?.source ?? null,
          currentSourceDocumentId: currentWinner?.sourceDocumentId ?? null,
          conflictingValue: stableNumber(incoming),
          conflictingSourceDocumentId: input.context?.sourceDocumentId ?? null,
          deltaPct: decision.deltaPct,
          lastObservedAt: observedAt,
        };
        if (existingOpen) {
          await client.reconciliationReviewQueue.update({
            where: { id: existingOpen.id },
            data: { ...reviewData, observationCount: { increment: 1 } },
          });
        } else {
          await client.reconciliationReviewQueue.create({
            data: {
              peCode: input.peCode,
              fy: input.fy,
              fieldName,
              conflictType: reviewConflictType,
              conflictingSource: input.source,
              status: 'open',
              observationCount: 1,
              ...reviewData,
            },
          });
        }
        this.logger.warn(
          `Reconciliation review refreshed: ${input.peCode} FY${input.fy} ${fieldName} ` +
            `canonical=${canonicalValue} source=${currentWinner?.source ?? 'none'} ` +
            `incoming=${incoming} source=${input.source} type=${reviewConflictType}`,
        );
      }

      results.push({
        fieldName,
        observationId: observation.id,
        observationKey,
        canonicalValueM: incoming,
        mayOwn,
        shouldWin,
        queued,
        conflictType,
        deltaPct: decision.deltaPct,
        reason,
      });
    }

    return results;
  }

  async applyWinnerFlags(
    input: { peCode: string; fy: number; results: readonly FieldReconcileResult[] },
    client: ReconciliationClient = this.prisma as unknown as ReconciliationClient,
  ): Promise<void> {
    for (const result of input.results) {
      if (!result.shouldWin) {
        await client.programElementYearSourceValue.update({
          where: { observationKey: result.observationKey },
          data: { isWinner: false },
        });
        continue;
      }
      await client.programElementYearSourceValue.updateMany({
        where: {
          peCode: input.peCode,
          fy: input.fy,
          fieldName: result.fieldName,
          isWinner: true,
          observationKey: { not: result.observationKey },
        },
        data: { isWinner: false },
      });
      await client.programElementYearSourceValue.update({
        where: { observationKey: result.observationKey },
        data: { isWinner: true },
      });
    }
  }
}
