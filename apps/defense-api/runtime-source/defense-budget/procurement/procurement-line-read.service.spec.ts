import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ProcurementLineReadService,
  buildProcurementCitationLabel,
} from './procurement-line-read.service.js';

const LINE_ID = 'line-1';
const YEAR_27 = 'year-27';
const YEAR_26 = 'year-26';

function source(over: Record<string, unknown>) {
  return {
    id: `src-${Math.random().toString(36).slice(2, 8)}`,
    yearId: null,
    docType: 'P',
    exhibitType: 'P-1',
    fy: 2027,
    sourceUrl: 'https://example.test/p1.pdf',
    pageNumber: 12,
    pageEnd: null,
    snippet: null,
    publisher: 'DoD Comptroller',
    confidence: 0.95,
    extractorVersion: null,
    sourceSpanHash: 'f'.repeat(64),
    sourceDocumentId: null,
    sourceDocument: null,
    metadata: {},
    ...over,
  };
}

function makePrisma(line: Record<string, unknown> | null, rows: Array<Record<string, unknown>> = []) {
  return {
    procurementLine: {
      findUnique: jest.fn(async () => line),
      findMany: jest.fn(async () => rows),
    },
  };
}

const line68 = {
  id: LINE_ID,
  appropriationCode: '0300D',
  appropriationTitle: 'Procurement, Defense-Wide',
  component: 'SOCOM',
  budgetActivity: 'BA 02: Special Operations Command',
  budgetSubActivity: 'U.S. Special Operations Command',
  p1LineNumber: 68,
  lineItemNumber: '0204WARSYS',
  title: 'Warrior Systems <$5M',
  relatedPeCode: '1160431BB',
  createdAt: new Date('2026-09-17T00:00:00Z'),
  updatedAt: new Date('2026-09-17T00:00:00Z'),
  years: [
    {
      id: YEAR_26, fy: 2026, sublineKey: '', sublineTitle: null, p1LineNumber: 68,
      request: new Prisma.Decimal('499.582'), hascMark: null, sascMark: null, hacDMark: null, sacDMark: null,
      conference: null, enacted: null, actuals: null, quantity: null, lastSyncedAt: new Date(),
    },
    {
      id: YEAR_27, fy: 2027, sublineKey: '', sublineTitle: null, p1LineNumber: 68,
      request: new Prisma.Decimal('511.016'), hascMark: null, sascMark: null, hacDMark: null, sacDMark: null,
      conference: null, enacted: null, actuals: null, quantity: 0, lastSyncedAt: new Date(),
    },
    {
      id: 'year-27-p1', fy: 2027, sublineKey: 'P1', sublineTitle: 'Satellite Deployable Node (SDN)', p1LineNumber: 68,
      request: new Prisma.Decimal('101.841'), hascMark: null, sascMark: null, hacDMark: null, sacDMark: null,
      conference: null, enacted: null, actuals: null, quantity: null, lastSyncedAt: new Date(),
    },
  ],
  // Deliberately shuffled: the service must impose proof-pack order.
  sources: [
    source({ id: 's-p5', exhibitType: 'P-5', fy: 2027, pageNumber: 3 }),
    source({ id: 's-p40a', exhibitType: 'P-40A', fy: 2027, pageNumber: 206, yearId: 'year-27-p1', metadata: { field: 'request', valueMillions: '101.841' } }),
    source({ id: 's-p1-26', exhibitType: 'P-1', fy: 2026, pageNumber: 12, yearId: YEAR_26 }),
    source({ id: 's-p40-27', exhibitType: 'P-40', fy: 2027, pageNumber: 205, yearId: YEAR_27, metadata: { field: 'request', valueMillions: '511.016000' } }),
    source({ id: 's-p1-27-b', exhibitType: 'P-1', fy: 2027, pageNumber: 40, yearId: YEAR_27 }),
    source({ id: 's-p1-27-a', exhibitType: 'P-1', fy: 2027, pageNumber: 12, yearId: YEAR_27, metadata: { field: 'request', valueMillions: '511.016000' } }),
    source({ id: 's-qty', exhibitType: 'P-40', fy: 2027, pageNumber: 205, pageEnd: 224, yearId: YEAR_27, metadata: { field: 'quantity', quantity: 0 } }),
  ],
};

describe('ProcurementLineReadService', () => {
  test('getLine normalizes the key, orders sources P-1 -> P-40 -> P-40A -> P-5 then FY desc then page asc, and returns wire numbers + exact strings', async () => {
    const prisma = makePrisma(line68);
    const service = new ProcurementLineReadService(prisma as never);
    const result = await service.getLine(' 0300d ', '0204warsys');

    expect(prisma.procurementLine.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appropriationCode_lineItemNumber: { appropriationCode: '0300D', lineItemNumber: '0204WARSYS' } },
      }),
    );
    expect(result.line).toMatchObject({ appropriationCode: '0300D', lineItemNumber: '0204WARSYS', p1LineNumber: 68, relatedPeCode: '1160431BB' });

    expect(result.years.map((y) => [y.fy, y.sublineKey, y.request, y.exact.request])).toEqual([
      [2026, null, 499.582, '499.582'],
      [2027, null, 511.016, '511.016'],
      [2027, 'P1', 101.841, '101.841'],
    ]);
    expect(result.years[1]!.quantity).toBe(0);

    expect(result.sources.map((s) => s.id)).toEqual([
      's-p1-27-a',
      's-p1-27-b',
      's-p1-26',
      's-p40-27',
      's-qty',
      's-p40a',
      's-p5',
    ]);
    expect(result.sources[0]!.deepLink).toBe('https://example.test/p1.pdf#page=12');
    expect(result.sources[0]!.citation).toBe(
      'P-1 Line 68 — 0204WARSYS FY2027 request $511.016M — Exhibit P-1, p. 12',
    );
    expect(result.sources.find((s) => s.id === 's-qty')!.citation).toBe(
      'P-1 Line 68 — 0204WARSYS FY2027 quantity 0 — Exhibit P-40, pp. 205-224',
    );
    expect(result.sources.find((s) => s.id === 's-p40a')!.citation).toBe(
      'P-1 Line 68 — 0204WARSYS FY2027 request $101.841M — Exhibit P-40A, p. 206',
    );
  });

  test('getLine 404s when the line does not exist and 400s on a malformed key', async () => {
    const service = new ProcurementLineReadService(makePrisma(null) as never);
    await expect(service.getLine('0300D', 'NOPE-LINE')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getLine('03 00D!', '0204WARSYS')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getLine('0300D', '')).rejects.toBeInstanceOf(BadRequestException);
  });

  test('search matches title (insensitive) OR line item number, clamps the limit, and reports counts', async () => {
    const prisma = makePrisma(null, [
      { ...line68, _count: { years: 3, sources: 7 } },
    ]);
    const service = new ProcurementLineReadService(prisma as never);
    const result = await service.search(' warrior ', '5000');

    expect(prisma.procurementLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { title: { contains: 'warrior', mode: 'insensitive' } },
            { lineItemNumber: { contains: 'WARRIOR' } },
          ],
        },
        take: 100,
        orderBy: [{ appropriationCode: 'asc' }, { p1LineNumber: 'asc' }, { lineItemNumber: 'asc' }],
      }),
    );
    expect(result).toMatchObject({ search: 'warrior', limit: 100, count: 1 });
    expect(result.items[0]).toMatchObject({ lineItemNumber: '0204WARSYS', yearCount: 3, sourceCount: 7 });

    await service.search(undefined, undefined);
    expect(prisma.procurementLine.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: {}, take: 25 }),
    );
  });

  test('citation label degrades gracefully without a line number, FY or page', () => {
    expect(
      buildProcurementCitationLabel({
        p1LineNumber: null, lineItemNumber: '0206CMR', fy: null, exhibitType: null, pageNumber: null, pageEnd: null, metadata: null,
      }),
    ).toBe('P-1 line — 0206CMR — Exhibit');
  });
});
