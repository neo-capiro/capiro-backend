/**
 * ProcurementLineWriterService — the ONLY writer for the canonical procurement
 * line tables (procurement_line / procurement_line_year / procurement_line_source).
 *
 * Input is the composer's input + output (the exact artifacts it consumed and
 * the `ProcurementFamilyReport` it produced), optionally a trusted V1 gate
 * decision. The pure planner (procurement-line-canonical-v1.ts) decides WHAT is
 * eligible; this service decides WHETHER anything is applied and applies it.
 *
 * Gating — dark by default:
 *   - `DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES` must be exactly '1', or the
 *     service returns a dry-run summary (`mode: 'dry_run'`, `wouldWrite` counts,
 *     every skip with its reason) and touches nothing. No Prisma call is made in
 *     dry-run mode — not even a read.
 *   - `options.dryRun: true` forces dry-run even when the env flag is set (the
 *     promotion script's default).
 *
 * Rules mirrored from the Program Element canonical path:
 *   - Only PASS assertions are written; REVIEW/REJECT are counted + reasoned.
 *   - Never reclassifies a BLIN as a PE: this service has no program_element
 *     delegate and never reads or writes any PE table.
 *   - Idempotent: lines upsert on (appropriationCode, lineItemNumber), years on
 *     (lineId, fy, sublineKey), sources on (lineId, sourceSpanHash). A second
 *     identical run reports 0 inserts.
 *   - Per-field MERGE on year rows: only asserted fields are set; existing values
 *     for fields this run did not assert are never nulled.
 *   - Every year value in the plan carries >=1 source row by construction; the
 *     writer additionally refuses to write a year that arrived with none.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PROCUREMENT_LINE_CANONICAL_WRITES_ENV,
  PROCUREMENT_LINE_WRITER_VERSION,
  planProcurementLineCanonicalWrites,
  procurementCanonicalWritesEnabled,
  type ProcurementLineCanonicalPlan,
  type ProcurementLineCanonicalRequest,
  type ProcurementLineSkip,
} from './procurement-line-canonical-v1.js';

export interface ProcurementLineWriteCounts {
  lines: number;
  years: number;
  yearValues: number;
  sources: number;
}

export interface ProcurementLineWriteSummary {
  writerVersion: typeof PROCUREMENT_LINE_WRITER_VERSION;
  mode: 'dry_run' | 'write';
  /** Whether the env flag was set when this call ran. */
  gateEnabled: boolean;
  gateEnv: typeof PROCUREMENT_LINE_CANONICAL_WRITES_ENV;
  decision: ProcurementLineCanonicalPlan['decision'];
  decisionSource: ProcurementLineCanonicalPlan['decisionSource'];
  scope: ProcurementLineCanonicalPlan['scope'];
  /** Present in dry-run mode: what a write WOULD apply. */
  wouldWrite?: ProcurementLineWriteCounts;
  /** Present in write mode: what was applied, split by insert vs update. */
  written?: {
    lines: { inserted: number; updated: number };
    years: { inserted: number; updated: number };
    sources: { inserted: number; updated: number };
    yearValues: number;
  };
  skipped: ProcurementLineSkip[];
  counts: ProcurementLineCanonicalPlan['counts'];
  /** Written-mode only: (appropriationCode, lineItemNumber) pairs touched. */
  lineKeys: string[];
}

export interface ProcurementLineWriteOptions {
  /** Force dry-run regardless of the env flag. */
  dryRun?: boolean;
  /** Injected for tests; defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class ProcurementLineWriterService {
  private readonly logger = new Logger(ProcurementLineWriterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Pure planning only — never touches the database. */
  plan(request: ProcurementLineCanonicalRequest): ProcurementLineCanonicalPlan {
    return planProcurementLineCanonicalWrites(request);
  }

  async write(
    request: ProcurementLineCanonicalRequest,
    options: ProcurementLineWriteOptions = {},
  ): Promise<ProcurementLineWriteSummary> {
    const env = options.env ?? process.env;
    const gateEnabled = procurementCanonicalWritesEnabled(env);
    const plan = planProcurementLineCanonicalWrites(request);
    const base = {
      writerVersion: PROCUREMENT_LINE_WRITER_VERSION,
      gateEnabled,
      gateEnv: PROCUREMENT_LINE_CANONICAL_WRITES_ENV,
      decision: plan.decision,
      decisionSource: plan.decisionSource,
      scope: plan.scope,
      skipped: plan.skipped,
      counts: plan.counts,
    } as const;

    if (!gateEnabled || options.dryRun) {
      return {
        ...base,
        mode: 'dry_run',
        wouldWrite: {
          lines: plan.counts.lines,
          years: plan.counts.years,
          yearValues: plan.counts.yearValues,
          sources: plan.counts.sources,
        },
        lineKeys: plan.lines.map((l) => l.key),
      };
    }

    const now = options.now ?? (() => new Date());
    const apply = (tx: Tx) => this.apply(tx, plan, now());
    const written = this.hasRootTransaction()
      ? await this.prisma.$transaction(apply, { maxWait: 10_000, timeout: 120_000 })
      : await apply(this.prisma as unknown as Tx);

    this.logger.log(
      `procurement canonical write: lines +${written.lines.inserted}/~${written.lines.updated}, years +${written.years.inserted}/~${written.years.updated}, sources +${written.sources.inserted}/~${written.sources.updated}, skipped ${plan.skipped.length}`,
    );
    return { ...base, mode: 'write', written, lineKeys: plan.lines.map((l) => l.key) };
  }

  private hasRootTransaction(): boolean {
    return typeof (this.prisma as unknown as { $transaction?: unknown }).$transaction === 'function';
  }

  private async apply(
    tx: Tx,
    plan: ProcurementLineCanonicalPlan,
    now: Date,
  ): Promise<NonNullable<ProcurementLineWriteSummary['written']>> {
    const written = {
      lines: { inserted: 0, updated: 0 },
      years: { inserted: 0, updated: 0 },
      sources: { inserted: 0, updated: 0 },
      yearValues: 0,
    };

    // Defensive: a year with no citation is never written, even if a planner
    // change ever let one through.
    const yearKeysWithSource = new Set(
      plan.sources.map((s) => s.yearKey).filter((k): k is string => k != null),
    );
    const eligibleYears = plan.years.filter((y) => yearKeysWithSource.has(y.key));
    const eligibleLineKeys = new Set(eligibleYears.map((y) => y.lineKey));

    const lineIds = new Map<string, string>();
    for (const line of plan.lines) {
      if (!eligibleLineKeys.has(line.key)) continue;
      const where = {
        appropriationCode_lineItemNumber: {
          appropriationCode: line.appropriationCode,
          lineItemNumber: line.lineItemNumber,
        },
      };
      const existing = await tx.procurementLine.findUnique({ where, select: { id: true } });
      const shared = {
        title: line.title,
        ...(line.appropriationTitle != null ? { appropriationTitle: line.appropriationTitle } : {}),
        ...(line.component != null ? { component: line.component } : {}),
        ...(line.budgetActivity != null ? { budgetActivity: line.budgetActivity } : {}),
        ...(line.budgetSubActivity != null ? { budgetSubActivity: line.budgetSubActivity } : {}),
        ...(line.p1LineNumber != null ? { p1LineNumber: line.p1LineNumber } : {}),
        ...(line.relatedPeCode != null ? { relatedPeCode: line.relatedPeCode } : {}),
        raw: {
          ...line.raw,
          identityNaturalKey: line.identityNaturalKey,
          printedLineItemNumber: line.printedLineItemNumber,
          writerVersion: PROCUREMENT_LINE_WRITER_VERSION,
        } as Prisma.InputJsonValue,
      };
      if (existing) {
        await tx.procurementLine.update({ where: { id: existing.id }, data: shared });
        lineIds.set(line.key, existing.id);
        written.lines.updated += 1;
      } else {
        const created = await tx.procurementLine.create({
          data: {
            appropriationCode: line.appropriationCode,
            lineItemNumber: line.lineItemNumber,
            ...shared,
          },
          select: { id: true },
        });
        lineIds.set(line.key, created.id);
        written.lines.inserted += 1;
      }
    }

    const yearIds = new Map<string, string>();
    for (const year of eligibleYears) {
      const lineId = lineIds.get(year.lineKey);
      if (!lineId) continue;
      const where = {
        lineId_fy_sublineKey: { lineId, fy: year.fy, sublineKey: year.sublineKey },
      };
      const existing = await tx.procurementLineYear.findUnique({ where, select: { id: true } });
      // Decimal columns accept exact decimal strings; never convert to float.
      const values: Record<string, string | number> = { ...year.values };
      if (year.quantity != null) values.quantity = year.quantity;
      written.yearValues += Object.keys(values).length;
      const shared = {
        ...values,
        ...(year.sublineTitle != null ? { sublineTitle: year.sublineTitle } : {}),
        ...(year.p1LineNumber != null ? { p1LineNumber: year.p1LineNumber } : {}),
        lastSyncedAt: now,
      };
      if (existing) {
        await tx.procurementLineYear.update({ where: { id: existing.id }, data: shared });
        yearIds.set(year.key, existing.id);
        written.years.updated += 1;
      } else {
        const created = await tx.procurementLineYear.create({
          data: { lineId, fy: year.fy, sublineKey: year.sublineKey, ...shared },
          select: { id: true },
        });
        yearIds.set(year.key, created.id);
        written.years.inserted += 1;
      }
    }

    for (const source of plan.sources) {
      const lineId = lineIds.get(source.lineKey);
      if (!lineId) continue;
      const yearId = source.yearKey ? (yearIds.get(source.yearKey) ?? null) : null;
      const where = { lineId_sourceSpanHash: { lineId, sourceSpanHash: source.sourceSpanHash } };
      const existing = await tx.procurementLineSource.findUnique({ where, select: { id: true } });
      const shared = {
        yearId,
        docType: source.docType,
        exhibitType: source.exhibitType,
        fy: source.fy,
        sourceUrl: source.sourceUrl,
        pageNumber: source.pageNumber,
        pageEnd: source.pageEnd,
        snippet: source.snippet,
        publisher: source.publisher,
        confidence: source.confidence,
        extractorVersion: source.extractorVersion,
        sourceDocumentId: source.sourceDocumentId,
        metadata: source.metadata as Prisma.InputJsonValue,
        observedAt: now,
      };
      if (existing) {
        await tx.procurementLineSource.update({ where: { id: existing.id }, data: shared });
        written.sources.updated += 1;
      } else {
        await tx.procurementLineSource.create({
          data: { lineId, sourceSpanHash: source.sourceSpanHash, ...shared },
          select: { id: true },
        });
        written.sources.inserted += 1;
      }
    }

    return written;
  }
}
