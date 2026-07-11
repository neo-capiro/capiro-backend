import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MANUAL_OVERRIDE_SOURCE, SOURCE_PRIORITY } from '../types.js';

/**
 * Cross-source reconciliation (Step 29, Boss Plan §4.1).
 *
 * Every program_element_year write routes through here. For each numeric field we:
 *   1. Log the per-source value to program_element_year_source_value.
 *   2. Compare against the current canonical value.
 *   3. Queue a reconciliation_review_queue entry when a conflict crosses threshold:
 *        - enacted field: ANY non-zero conflict (enacted is ground truth — any
 *          disagreement must be reviewed regardless of magnitude), OR
 *        - other fields: relative delta > 10%.
 *
 * The canonical value itself is owned by the writer's source-priority logic; this
 * service only logs + flags. A lower-priority source never overwrites canonical,
 * but its conflicting value is still logged and (if over threshold) queued.
 */

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

const DELTA_THRESHOLD = 0.1; // 10% for non-enacted fields

export interface ReconcileInput {
  peCode: string;
  fy: number;
  source: string; // base source tag, e.g. 'hasc_report' (priority key)
  /** Field → numeric value from this write (only fields the source set). */
  values: Partial<Record<ReconcileField, number | null>>;
}

export interface FieldReconcileResult {
  fieldName: string;
  logged: boolean;
  queued: boolean;
  deltaPct: number | null;
  reason?: 'enacted_conflict' | 'over_threshold';
}

/** Source-priority rank — lower index = higher priority (canonical wins). */
export function sourceRank(source: string): number {
  const base = source.replace(/_fy\d+$/i, ''); // strip _fy27 suffix if present
  const idx = SOURCE_PRIORITY.indexOf(base as (typeof SOURCE_PRIORITY)[number]);
  return idx === -1 ? SOURCE_PRIORITY.length : idx;
}

/** Relative delta between two numbers (|a-b| / max(|a|,|b|)); 0 when both 0. */
export function relativeDelta(a: number, b: number): number {
  if (a === b) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

/**
 * Pure threshold decision: given the canonical value and an incoming conflicting
 * value for a field, should it be queued for review?
 */
export function shouldQueue(
  fieldName: string,
  canonical: number | null,
  incoming: number | null,
): { queued: boolean; deltaPct: number | null; reason?: 'enacted_conflict' | 'over_threshold' } {
  if (incoming === null || canonical === null) return { queued: false, deltaPct: null };
  if (canonical === incoming) return { queued: false, deltaPct: 0 };

  const delta = relativeDelta(canonical, incoming);
  if (fieldName === 'enacted') {
    // Any conflict on enacted is reviewable regardless of magnitude.
    return { queued: true, deltaPct: delta, reason: 'enacted_conflict' };
  }
  if (delta > DELTA_THRESHOLD) {
    return { queued: true, deltaPct: delta, reason: 'over_threshold' };
  }
  return { queued: false, deltaPct: delta };
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reconcile an incoming write against canonical. Logs every field value to the
   * source-value table and queues review entries for over-threshold conflicts.
   * Returns per-field results (used by tests + writer instrumentation).
   */
  async reconcile(input: ReconcileInput): Promise<FieldReconcileResult[]> {
    const canonical = await this.prisma.programElementYear.findUnique({
      where: { peCode_fy: { peCode: input.peCode, fy: input.fy } },
    });

    const results: FieldReconcileResult[] = [];

    for (const [fieldName, rawValue] of Object.entries(input.values)) {
      const incoming = rawValue ?? null;
      if (incoming === null) continue;

      // 1. Log the per-source value.
      await this.prisma.programElementYearSourceValue.create({
        data: {
          peCode: input.peCode,
          fy: input.fy,
          fieldName,
          source: input.source,
          valueJsonb: incoming,
          valueDecimal: incoming,
          isWinner: false,
        },
      });

      // 2. Compare against canonical (DB value for this field, if any).
      const canonicalValue = canonical
        ? this.toNumber((canonical as Record<string, unknown>)[fieldName])
        : null;

      const decision = shouldQueue(fieldName, canonicalValue, incoming);
      // A capiro_admin override (manual_override) is authoritative — it is logged for
      // history above but is never itself queued for review (Step 0.2).
      const queued = decision.queued && input.source !== MANUAL_OVERRIDE_SOURCE;

      // 3. Queue if over threshold. Dedup: don't re-queue an identical open entry.
      if (queued) {
        const existingOpen = await this.prisma.reconciliationReviewQueue.findFirst({
          where: {
            peCode: input.peCode,
            fy: input.fy,
            fieldName,
            conflictingSource: input.source,
            status: 'open',
          },
        });
        if (!existingOpen) {
          await this.prisma.reconciliationReviewQueue.create({
            data: {
              peCode: input.peCode,
              fy: input.fy,
              fieldName,
              currentValue: canonicalValue !== null ? String(canonicalValue) : null,
              conflictingSource: input.source,
              conflictingValue: String(incoming),
              deltaPct: decision.deltaPct,
              status: 'open',
            },
          });
        }
        this.logger.warn(
          `Reconciliation conflict queued: ${input.peCode} FY${input.fy} ${fieldName} ` +
            `canonical=${canonicalValue} vs ${input.source}=${incoming} (${decision.reason})`,
        );
      }

      results.push({
        fieldName,
        logged: true,
        queued,
        deltaPct: decision.deltaPct,
        reason: decision.reason,
      });
    }

    return results;
  }

  private toNumber(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    // Prisma Decimal → string/object with toString
    const n = Number(
      typeof v === 'object' && v !== null ? (v as { toString(): string }).toString() : v,
    );
    return Number.isFinite(n) ? n : null;
  }
}
