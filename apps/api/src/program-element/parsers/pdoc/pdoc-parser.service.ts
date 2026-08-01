import { Injectable, Logger } from '@nestjs/common';
import { isValidProgramCode, thousandsToMillions } from '../../jbook/jbook-extract.js';
import { ProgramElementWriterService } from '../../program-element-writer.service.js';
import type { PeYearWriteContext } from '../../types.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

/**
 * P-Doc (Procurement budget justification) parser — Step 27.
 *
 * Procurement books are table-heavy: a parent PE carries FY totals (quantity +
 * dollars + unit cost) and a set of child line items (kit codes / sub-quantities).
 * This parser loads:
 *   - the parent PE via the program-element writer (appropriationType='PROC',
 *     source 'p_doc_<service>_fy<NN>'), with FY request totals on
 *     program_element_year, and
 *   - child line items into program_element_procurement_line (hierarchy preserved
 *     by pe_code).
 *
 * Deterministic offline extraction (pdfplumber tool → committed rows artifact);
 * this service is the pure parser + DB loader. No Firecrawl/LLM at runtime — the
 * deterministic pass is the trustworthy one for budget quantities/dollars (the
 * same reason the R-2 pipeline is deterministic).
 */

export type ProcurementService = 'ARMY' | 'NAVY' | 'AF' | 'SF' | 'USMC' | 'DW' | 'DARPA';

/** Parent-PE FY total row. */
export interface ProcurementFyRow {
  fy: number;
  quantity: number | null;
  requestDollarsThousands: number | null;
  unitCostDollars: number | null;
}

/** Child sub-line item under a parent PE. */
export interface ProcurementLineItem {
  description: string;
  fy: number;
  quantity: number | null;
  dollars: number | null;
  unitCost?: number | null;
}

/** One parent procurement PE with its FY totals + child line items. */
export interface ProcurementPeRecord {
  peCode: string;
  title: string;
  service: ProcurementService;
  budgetActivity: string | null;
  lineNumber: string | null;
  programOfRecord: string | null;
  fyData: ProcurementFyRow[];
  lineItems: ProcurementLineItem[];
}

/** Raw extracted PE block from the offline pdfplumber tool. */
export interface ExtractedProcurementPe {
  peCode?: string | null;
  title?: string | null;
  budgetActivity?: string | null;
  lineNumber?: string | null;
  programOfRecord?: string | null;
  fyData?: Array<Record<string, unknown>> | null;
  lineItems?: Array<Record<string, unknown>> | null;
  [key: string]: unknown;
}

export interface PDocLoadResult {
  source: string;
  pesSeen: number;
  pesUpserted: number;
  pesChanged: number;
  lineItemsUpserted: number;
  quarantined: number;
}

/** Normalize a money/quantity token to a number. Parenthesized = negative. */
export function parseNum(token: string | number | null | undefined): number | null {
  if (token === null || token === undefined) return null;
  if (typeof token === 'number') return Number.isFinite(token) ? token : null;
  const t = token.trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[(),$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Build the writer source tag, e.g. p_doc_army_fy27 / p_doc_navy_fy27. */
export function pdocSource(service: ProcurementService, fy: number): string {
  const fy2 = String(fy).slice(-2);
  return `p_doc_${service.toLowerCase()}_fy${fy2}`;
}

/** Parse raw extracted PE blocks into typed procurement records (parent + children). */
export function parseProcurementPes(
  pes: ExtractedProcurementPe[],
  opts: { fy: number; service: ProcurementService },
): ProcurementPeRecord[] {
  const out: ProcurementPeRecord[] = [];
  for (const pe of pes) {
    const peCode = (pe.peCode ?? '').toString().trim().toUpperCase();
    if (!peCode) continue;

    const fyData: ProcurementFyRow[] = (pe.fyData ?? []).map((r) => ({
      fy: Number(r.fy ?? opts.fy),
      quantity: parseNum((r.quantity ?? null) as never),
      requestDollarsThousands: parseNum(
        (r.requestDollarsThousands ?? r.request_dollars_thousands ?? r.dollars ?? null) as never,
      ),
      unitCostDollars: parseNum((r.unitCostDollars ?? r.unit_cost_dollars ?? r.unitCost ?? null) as never),
    }));

    const lineItems: ProcurementLineItem[] = (pe.lineItems ?? [])
      .map((li) => ({
        description: String(li.description ?? '').trim(),
        fy: Number(li.fy ?? opts.fy),
        quantity: parseNum((li.quantity ?? null) as never),
        dollars: parseNum((li.dollars ?? null) as never),
        unitCost: parseNum((li.unitCost ?? li.unit_cost ?? null) as never),
      }))
      .filter((li) => li.description.length > 0);

    out.push({
      peCode,
      title: (pe.title ?? '').toString().trim(),
      service: opts.service,
      budgetActivity: pe.budgetActivity ? String(pe.budgetActivity) : null,
      lineNumber: pe.lineNumber ? String(pe.lineNumber) : null,
      programOfRecord: pe.programOfRecord ? String(pe.programOfRecord) : null,
      fyData,
      lineItems,
    });
  }
  return out;
}

@Injectable()
export class PDocParserService {
  private readonly logger = new Logger(PDocParserService.name);

  constructor(
    private readonly writer: ProgramElementWriterService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Load parsed procurement PEs. Parent PE → writer (validates pe_code,
   * quarantines bad ones, source priority + IntelligenceChange via the writer);
   * FY totals → program_element_year; child line items → procurement_line table.
   */
  async load(
    records: ProcurementPeRecord[],
    service: ProcurementService,
    fy: number,
    sourceUrl?: string,
    writeContext?: PeYearWriteContext,
  ): Promise<PDocLoadResult> {
    const source = pdocSource(service, fy);
    let pesUpserted = 0;
    let pesChanged = 0;
    let lineItemsUpserted = 0;
    let quarantined = 0;

    for (const rec of records) {
      if (!isValidProgramCode(rec.peCode) || !rec.title) {
        await this.writer.quarantine(rec, `Invalid procurement code in ${source}: ${rec.peCode}`, source);
        quarantined += 1;
        continue;
      }

      // Parent PE record (procurement appropriation).
      await this.writer.upsertProgramElement(
        {
          peCode: rec.peCode,
          title: rec.title,
          service: rec.service,
          appropriationType: 'PROC',
          budgetActivity: rec.budgetActivity,
          lineNumber: rec.lineNumber,
          programOfRecord: rec.programOfRecord,
          pDocUrl: sourceUrl ?? null,
          raw: rec,
        },
        source,
        0.95,
      );
      pesUpserted += 1;

      // Parent FY totals → program_element_year (request column carries the dollars).
      // P-1 exhibits print dollars in THOUSANDS; convert to the canonical MILLIONS
      // unit so procurement requests aren't 1000x inflated against the UI/fixtures.
      for (const fyRow of rec.fyData) {
        const yearContext: PeYearWriteContext | undefined = writeContext
          ? {
              ...writeContext,
              originalValues: {
                ...(writeContext.originalValues ?? {}),
                ...(fyRow.requestDollarsThousands != null
                  ? {
                      request: {
                        value: fyRow.requestDollarsThousands,
                        unit: 'thousands' as const,
                      },
                    }
                  : {}),
              },
            }
          : undefined;
        const result = await this.writer.upsertProgramElementYear(
          {
            peCode: rec.peCode,
            fy: fyRow.fy,
            request: thousandsToMillions(fyRow.requestDollarsThousands),
            notes: fyRow.quantity !== null ? `qty=${fyRow.quantity}` : null,
            raw: fyRow,
          },
          source,
          yearContext,
        );
        if (result.changed) pesChanged += 1;
      }

      // Child line items → procurement_line table (hierarchy by pe_code).
      for (const li of rec.lineItems) {
        await this.prisma.programElementProcurementLine.upsert({
          where: {
            peCode_lineDescription_fy: { peCode: rec.peCode, lineDescription: li.description, fy: li.fy },
          },
          create: {
            peCode: rec.peCode,
            lineDescription: li.description,
            fy: li.fy,
            quantity: li.quantity,
            dollars: li.dollars,
            unitCost: li.unitCost ?? null,
            source,
            sourceUrl: sourceUrl ?? null,
            raw: li as object,
          },
          update: {
            quantity: li.quantity,
            dollars: li.dollars,
            unitCost: li.unitCost ?? null,
            source,
            sourceUrl: sourceUrl ?? null,
            lastSyncedAt: new Date(),
          },
        });
        lineItemsUpserted += 1;
      }
    }

    this.logger.log(
      `${source}: ${pesUpserted} PEs, ${pesChanged} year-deltas, ${lineItemsUpserted} line items, ${quarantined} quarantined`,
    );
    return { source, pesSeen: records.length, pesUpserted, pesChanged, lineItemsUpserted, quarantined };
  }
}
