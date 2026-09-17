/**
 * ProcurementLineReadService — read-only access to the canonical procurement
 * line tables. Never writes, never reads a program_element table.
 *
 * `getLine` returns the PE "proof pack" shape for a P-1 line: the line, its
 * per-FY rows, and every citation ordered exhibit-first
 * (P-1 -> P-40 -> P-40A -> P-5 -> ...), then FY desc, then page asc — the same
 * discipline as `GET /program-elements/:peCode/sources`.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { compareProcurementProofPackSources } from './procurement-line-canonical-v1.js';

const APPROPRIATION_CODE_RE = /^[A-Z0-9]{1,16}$/;
const LINE_ITEM_NUMBER_RE = /^[A-Z0-9][A-Z0-9_.\-/]{0,31}$/;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

const num = (v: Prisma.Decimal | null | undefined): number | null =>
  v == null ? null : Number(v);

/** Exact $M decimal as a string for callers that must not lose precision. */
const dec = (v: Prisma.Decimal | null | undefined): string | null => (v == null ? null : String(v));

export function normalizeAppropriationCode(raw: string): string {
  const code = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!APPROPRIATION_CODE_RE.test(code)) {
    throw new BadRequestException(`Invalid appropriation code "${raw}"`);
  }
  return code;
}

export function normalizeLineItemNumber(raw: string): string {
  const code = (raw ?? '').trim().toUpperCase();
  if (!LINE_ITEM_NUMBER_RE.test(code)) {
    throw new BadRequestException(`Invalid line item number "${raw}"`);
  }
  return code;
}

const FIELD_LABEL: Record<string, string> = {
  request: 'request',
  hascMark: 'HASC mark',
  sascMark: 'SASC mark',
  hacDMark: 'HAC-D mark',
  sacDMark: 'SAC-D mark',
  conference: 'conference',
  enacted: 'enacted',
  actuals: 'actuals',
  quantity: 'quantity',
};

function formatMillions(value: string): string {
  // Trim trailing zeros from an exact decimal string; keep at least the integer part.
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed.length > 0 ? trimmed : '0';
}

/**
 * Human citation label for one source row, e.g.
 * "P-1 Line 68 — 0204WARSYS FY2027 request $511.016M — Exhibit P-1, p. 12".
 * Built server-side so every consumer cites identically.
 */
export function buildProcurementCitationLabel(input: {
  p1LineNumber: number | null;
  lineItemNumber: string;
  fy: number | null;
  exhibitType: string | null;
  pageNumber: number | null;
  pageEnd: number | null;
  metadata: unknown;
}): string {
  const meta = (input.metadata ?? {}) as Record<string, unknown>;
  const field = typeof meta.field === 'string' ? meta.field : null;
  const valueM = typeof meta.valueMillions === 'string' ? meta.valueMillions : null;
  const quantity = typeof meta.quantity === 'number' ? meta.quantity : null;

  const head = input.p1LineNumber != null ? `P-1 Line ${input.p1LineNumber}` : 'P-1 line';
  const fyPart = input.fy != null ? ` FY${input.fy}` : '';
  let valuePart = '';
  if (field && field !== 'quantity' && valueM != null) {
    valuePart = ` ${FIELD_LABEL[field] ?? field} $${formatMillions(valueM)}M`;
  } else if (field === 'quantity' && quantity != null) {
    valuePart = ` quantity ${quantity}`;
  }
  const exhibit = input.exhibitType ? `Exhibit ${input.exhibitType}` : 'Exhibit';
  const page =
    input.pageNumber != null
      ? input.pageEnd != null && input.pageEnd > input.pageNumber
        ? `, pp. ${input.pageNumber}-${input.pageEnd}`
        : `, p. ${input.pageNumber}`
      : '';
  return `${head} — ${input.lineItemNumber}${fyPart}${valuePart} — ${exhibit}${page}`;
}

@Injectable()
export class ProcurementLineReadService {
  constructor(private readonly prisma: PrismaService) {}

  async getLine(appropriationCodeRaw: string, lineItemNumberRaw: string) {
    const appropriationCode = normalizeAppropriationCode(appropriationCodeRaw);
    const lineItemNumber = normalizeLineItemNumber(lineItemNumberRaw);

    const line = await this.prisma.procurementLine.findUnique({
      where: { appropriationCode_lineItemNumber: { appropriationCode, lineItemNumber } },
      include: {
        years: { orderBy: [{ fy: 'asc' }, { sublineKey: 'asc' }] },
        sources: {
          include: { sourceDocument: { select: { title: true, budgetCycle: true, sha256: true } } },
        },
      },
    });
    if (!line) {
      throw new NotFoundException(
        `Procurement line ${appropriationCode}/${lineItemNumber} not found`,
      );
    }

    const years = line.years.map((y) => ({
      id: y.id,
      fy: y.fy,
      sublineKey: y.sublineKey === '' ? null : y.sublineKey,
      sublineTitle: y.sublineTitle,
      p1LineNumber: y.p1LineNumber,
      request: num(y.request),
      hascMark: num(y.hascMark),
      sascMark: num(y.sascMark),
      hacDMark: num(y.hacDMark),
      sacDMark: num(y.sacDMark),
      conference: num(y.conference),
      enacted: num(y.enacted),
      actuals: num(y.actuals),
      quantity: y.quantity,
      /** Exact $M decimal strings, for consumers that must not round. */
      exact: {
        request: dec(y.request),
        hascMark: dec(y.hascMark),
        sascMark: dec(y.sascMark),
        hacDMark: dec(y.hacDMark),
        sacDMark: dec(y.sacDMark),
        conference: dec(y.conference),
        enacted: dec(y.enacted),
        actuals: dec(y.actuals),
      },
      lastSyncedAt: y.lastSyncedAt,
    }));

    const yearById = new Map(line.years.map((y) => [y.id, y]));
    const sources = [...line.sources]
      .sort((a, b) => compareProcurementProofPackSources(a, b))
      .map((s) => {
        const year = s.yearId ? yearById.get(s.yearId) : undefined;
        return {
          id: s.id,
          yearId: s.yearId,
          docType: s.docType,
          exhibitType: s.exhibitType,
          fy: s.fy,
          sourceUrl: s.sourceUrl,
          pageNumber: s.pageNumber,
          pageEnd: s.pageEnd,
          snippet: s.snippet,
          publisher: s.publisher,
          confidence: s.confidence,
          extractorVersion: s.extractorVersion,
          sourceSpanHash: s.sourceSpanHash,
          sourceDocumentId: s.sourceDocumentId,
          sourceDocument: s.sourceDocument,
          metadata: s.metadata,
          deepLink: s.pageNumber != null ? `${s.sourceUrl}#page=${s.pageNumber}` : s.sourceUrl,
          citation: buildProcurementCitationLabel({
            p1LineNumber: year?.p1LineNumber ?? line.p1LineNumber,
            lineItemNumber: line.lineItemNumber,
            fy: s.fy,
            exhibitType: s.exhibitType,
            pageNumber: s.pageNumber,
            pageEnd: s.pageEnd,
            metadata: s.metadata,
          }),
        };
      });

    return {
      line: {
        id: line.id,
        appropriationCode: line.appropriationCode,
        appropriationTitle: line.appropriationTitle,
        component: line.component,
        budgetActivity: line.budgetActivity,
        budgetSubActivity: line.budgetSubActivity,
        p1LineNumber: line.p1LineNumber,
        lineItemNumber: line.lineItemNumber,
        title: line.title,
        relatedPeCode: line.relatedPeCode,
        createdAt: line.createdAt,
        updatedAt: line.updatedAt,
      },
      years,
      sources,
    };
  }

  async search(searchRaw?: string, limitRaw?: string | number) {
    const search = (searchRaw ?? '').trim();
    const parsedLimit = Number(limitRaw ?? DEFAULT_SEARCH_LIMIT);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;

    const where: Prisma.ProcurementLineWhereInput = search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { lineItemNumber: { contains: search.toUpperCase() } },
          ],
        }
      : {};

    const rows = await this.prisma.procurementLine.findMany({
      where,
      orderBy: [{ appropriationCode: 'asc' }, { p1LineNumber: 'asc' }, { lineItemNumber: 'asc' }],
      take: limit,
      include: { _count: { select: { years: true, sources: true } } },
    });

    return {
      search,
      limit,
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        appropriationCode: r.appropriationCode,
        appropriationTitle: r.appropriationTitle,
        component: r.component,
        budgetActivity: r.budgetActivity,
        budgetSubActivity: r.budgetSubActivity,
        p1LineNumber: r.p1LineNumber,
        lineItemNumber: r.lineItemNumber,
        title: r.title,
        relatedPeCode: r.relatedPeCode,
        yearCount: r._count.years,
        sourceCount: r._count.sources,
      })),
    };
  }
}
