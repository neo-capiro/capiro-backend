import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { inflateSync } from 'node:zlib';
import { HillDayExportService } from './hillday-export.service.js';
import type { HillDayDocumentView } from './hillday.types.js';

/** The dedicated export signing key is the only key exports may use. */
const SIGNING_KEY = 'synthetic-export-signing-key';

/**
 * Runs `run` with `WORKSPACE_EXPORT_SIGNING_SECRET` set to a synthetic value
 * (`undefined` removes it), restoring the previous state afterwards. The service
 * resolves the key at construction, so the value must be set before it is built.
 */
async function withSigningKey<T>(key: string | undefined, run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
  if (key === undefined) delete process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
  else process.env.WORKSPACE_EXPORT_SIGNING_SECRET = key;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
    else process.env.WORKSPACE_EXPORT_SIGNING_SECRET = previous;
  }
}

/** Read the first page's standard-font text from PDFKit's actual content stream. */
function firstPageText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const contentsId = /\/Contents (\d+) 0 R/.exec(raw)?.[1];
  if (!contentsId) throw new Error('First page content is missing');
  const content = new RegExp(`(?:^|\\n)${contentsId} 0 obj\\b([\\s\\S]*?)endobj`).exec(raw)?.[1];
  const stream = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(content ?? '')?.[1];
  if (!stream) throw new Error('First page stream is missing');
  const decoded = inflateSync(Buffer.from(stream, 'latin1')).toString('latin1');
  return [...decoded.matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join('').replace(/\s/g, '');
}

function view(sections: number): HillDayDocumentView {
  const secs = Array.from({ length: sections }, (_, i) => ({
    sectionId: `m-${i + 1}`,
    meetingId: `m-${i + 1}`,
    eventId: `e-${i + 1}`,
    number: i + 1,
    time: `${8 + i}:45 AM`,
    duration: '30 min',
    member: `Sen. Member ${i + 1} (R-MS)`,
    subline: 'Republican · Mississippi · Dirksen 555',
    facts: [
      { k: 'Office', v: 'Dirksen 555' },
      { k: 'Attendees', v: 'Cal Perrine, Hannah Voight' },
      { k: 'Committees', v: 'Armed Services (Chair) · Commerce, Science and Transportation' },
      { k: 'Party · state', v: 'Republican · Mississippi' },
    ],
    focus: i === 1 ? null : 'Ask the Chairman’s staff to hold the line. '.repeat(6),
    background: i === 1 ? null : 'Wicker chairs Armed Services. '.repeat(8),
    status: i === 1 ? ('unavailable' as const) : ('done' as const),
    reason: i === 1 ? 'provider_timeout' : null,
    flags: i === 1 ? [{ kind: 'generation_failed' as const, detail: 'timeout' }] : [],
    edited: { focus: false, background: false, at: null },
    attendees: [],
  }));
  return {
    id: 'doc-1',
    name: 'Kela Systems Hill Day Schedule',
    status: 'partial',
    blueprint: { slug: 'hill-day-schedule', name: 'Hill Day Schedule' },
    client: { id: 'client-1', name: 'Kela Systems', mono: 'KS', hasLogo: false },
    firm: { name: 'Maven Advocacy' },
    owner: { id: 'u', name: 'Neo Martinez', initials: 'NM' },
    lookbackDays: 90,
    timeZone: 'America/New_York',
    weekStart: '2026-09-14',
    resolutionStatus: 'partial',
    cover: {
      title: 'Hill Day Schedule',
      dateline: 'Wednesday, September 16, 2026 · 3 congressional meetings · prepared for Kela Systems by Maven Advocacy',
      facts: [
        { k: 'Sponsor', v: 'Kela Systems' },
        { k: 'Prepared by', v: 'Maven Advocacy' },
        { k: 'Meetings', v: String(sections) },
        { k: 'Date', v: 'Wednesday, September 16, 2026' },
        { k: 'Lead', v: 'Neo Martinez' },
        { k: 'Revision', v: '1 · as generated' },
      ],
    },
    firstPage: null,
    summaryColumns: ['time', 'member', 'office', 'room', 'minutes', 'staffLead'],
    summary: secs.map((s) => ({
      sectionId: s.sectionId,
      meetingId: s.meetingId,
      time: s.time,
      member: s.member,
      office: 'Republican · Mississippi',
      room: 'Dirksen 555',
      minutes: '30',
      staffLead: 'Cal Perrine',
    })),
    sections: secs,
    provenance: {
      generatedAt: '2026-09-01T00:00:00.000Z',
      model: 'claude-sonnet-4-6',
      sourceCounts: [{ id: 'directory', label: 'Directory', count: 9, detail: '9 records' }],
      corrections: ['Office set to Sen. Susan Collins (R-ME) by you'],
      failedUnits: 1,
      quality: 0.67,
      totalSources: 9,
    },
    generation: { lastJobId: 'job-1', status: 'complete' },
    meetingCount: sections,
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('HillDayExportService.renderPdf', () => {
  it('renders a paginated PDF: cover, one page per meeting', async () => {
    const service = new HillDayExportService({} as never, {} as never, {} as never);
    const pdf = await service.renderPdf(view(3), { pageSize: 'letter', logo: null });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? [];
    // cover + 3 sections — no provenance page in the client-facing PDF
    expect(pages.length).toBe(4);
    expect(pdf.length).toBeGreaterThan(4_000);
  });

  it('renders A4 when asked', async () => {
    const service = new HillDayExportService({} as never, {} as never, {} as never);
    const pdf = await service.renderPdf(view(1), { pageSize: 'a4', logo: null });
    expect(pdf.toString('latin1')).toContain('595.28 841.89');
  });

  it('exports edited first-page values and omits hidden columns and their cells', async () => {
    const service = new HillDayExportService({} as never, {} as never, {} as never);
    const draft = view(3);
    draft.cover.title = 'October Advocacy Day';
    draft.cover.dateline = 'Arrival and security screening at 12:30 PM';
    draft.cover.facts[4]!.v = 'Alex Chen, Government Affairs and Congressional Engagement Lead';
    draft.summaryColumns = ['time', 'member', 'room'];
    draft.summary[0]!.room = 'Visitor center room 201';
    draft.summary.forEach((r) => { r.office = 'HIDDEN_OFFICE_SENTINEL'; r.minutes = 'HIDDEN_MIN_SENTINEL'; r.staffLead = 'HIDDEN_STAFF_SENTINEL'; });
    const pdf = await service.renderPdf(draft, { pageSize: 'letter', logo: null });
    const text = firstPageText(pdf);
    expect(text).toContain('OctoberAdvocacyDay');
    expect(text).toContain('Arrivalandsecurityscreeningat12:30PM');
    expect(text).toContain('AlexChen,GovernmentAffairsandCongressionalEngagementLead');
    expect(text).toContain('Visitorcenterroom201');
    expect(text).not.toMatch(/HIDDEN_|OFFICE|STAFFLEAD/);
    expect(text).toContain('TIMEMEMBERROOM');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? [];
    expect(pages).toHaveLength(4);
  });

  it.each(['title', 'dateline', 'fact', 'row'])('rejects an oversized %s with a useful error instead of malformed pagination', async (field) => {
    const service = new HillDayExportService({} as never, {} as never, {} as never);
    const draft = view(1);
    const long = 'X\n'.repeat(field === 'title' ? 100 : 200);
    if (field === 'title') draft.cover.title = long;
    if (field === 'dateline') draft.cover.dateline = long;
    if (field === 'fact') draft.cover.facts[0]!.v = long;
    if (field === 'row') draft.summary[0]!.room = long;
    await expect(service.renderPdf(draft, { pageSize: 'letter', logo: null })).rejects.toThrow(/too tall.*Shorten/);
  });

  it('records an oversized export as failed and never stores it as ready', async () => {
    const draft = view(1);
    draft.cover.facts[0]!.v = 'X\n'.repeat(200);
    const row = { id: 'exp-1', documentId: draft.id, format: 'pdf', pageSize: 'letter', status: 'queued', filename: null, sizeBytes: null, error: null, createdAt: new Date() };
    const prisma = { wsHillDayExport: {
      create: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    } };
    const documents = { assertDoc: async () => ({ ownerId: 'owner' }), get: async () => draft };
    const bridge = { branding: async () => ({ ok: false }) };
    await withSigningKey(SIGNING_KEY, async () => {
      const service = new HillDayExportService(
        prisma as never,
        documents as never,
        bridge as never,
      );
      const result = await service.create('tenant', 'owner', draft.id, 'letter');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Cover facts');
      expect(result.url).toBeNull();
      expect(prisma.wsHillDayExport.update).toHaveBeenCalledTimes(1);
      expect(prisma.wsHillDayExport.update.mock.calls[0]?.[0].data).not.toHaveProperty('file');
    });
  });
});

/** A stored, ready export plus the admission double its download path needs. */
function readyExport() {
  const file = Buffer.from('%PDF-1.7 test');
  const row = {
    id: 'exp-1',
    tenantId: 'tenant',
    actorId: 'owner',
    documentId: 'doc-1',
    status: 'ready',
    pageSize: 'letter',
    file,
    filename: 'x.pdf',
    sizeBytes: file.length,
    error: null,
    createdAt: new Date('2026-10-25T12:00:00Z'),
  };
  const prisma = { wsHillDayExport: { findFirst: jest.fn(async () => row) } };
  const documents = { assertDoc: async () => ({ ownerId: 'owner' }) };
  return { file, prisma, documents };
}

describe('HillDayExportService signed URLs', () => {
  it('serves the stored bytes for a valid signature and refuses tampering or expiry', async () => {
    await withSigningKey(SIGNING_KEY, async () => {
      const { file, prisma, documents } = readyExport();
      const service = new HillDayExportService(prisma as never, documents as never, {} as never);
      const exp = Date.now() + 60_000;
      const path = service.signedPath('doc-1', 'exp-1', exp);
      const sig = new URL(`https://x${path}`).searchParams.get('sig')!;
      const served = await service.file('doc-1', 'exp-1', String(exp), sig);
      expect(served.buffer.equals(file)).toBe(true);
      expect(served.filename).toBe('x.pdf');
      await expect(
        service.file('doc-1', 'exp-1', String(exp), sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.file('doc-1', 'exp-1', String(Date.now() - 1), sig),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.file('doc-2', 'exp-1', String(exp), sig)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});

describe('HillDayExportService signing configuration', () => {
  it('refuses grant creation before any render or persisted export when the dedicated key is missing', async () => {
    await withSigningKey(undefined, async () => {
      const draft = view(1);
      const row = {
        id: 'exp-1',
        documentId: draft.id,
        format: 'pdf',
        pageSize: 'letter',
        status: 'queued',
        filename: null,
        sizeBytes: null,
        error: null,
        createdAt: new Date(),
      };
      const prisma = {
        wsHillDayExport: { create: jest.fn(async () => row), update: jest.fn(async () => row) },
      };
      const documents = { assertDoc: async () => ({ ownerId: 'owner' }), get: async () => draft };
      const bridge = { branding: async () => ({ ok: false }) };
      const service = new HillDayExportService(
        prisma as never,
        documents as never,
        bridge as never,
      );
      await expect(service.create('tenant', 'owner', draft.id, 'letter')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.wsHillDayExport.create).not.toHaveBeenCalled();
      expect(prisma.wsHillDayExport.update).not.toHaveBeenCalled();
    });
  });

  it('refuses a blank dedicated key even when the internal service secret is configured', async () => {
    const previousInternal = process.env.INTERNAL_SERVICE_SECRET;
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-internal-service-secret';
    try {
      await withSigningKey('   ', async () => {
        const { prisma, documents } = readyExport();
        const service = new HillDayExportService(prisma as never, documents as never, {} as never);
        const exp = String(Date.now() + 60_000);
        await expect(service.file('doc-1', 'exp-1', exp, 'sig')).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(() => service.signedPath('doc-1', 'exp-1', Number(exp))).toThrow(
          ServiceUnavailableException,
        );
      });
    } finally {
      if (previousInternal === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
      else process.env.INTERNAL_SERVICE_SECRET = previousInternal;
    }
  });

  it('mints no grant for a ready export when the dedicated key is missing', async () => {
    await withSigningKey(undefined, async () => {
      const { prisma, documents } = readyExport();
      const service = new HillDayExportService(prisma as never, documents as never, {} as never);
      const view = await service.get('tenant', 'doc-1', 'exp-1', 'owner');
      expect(view.status).toBe('ready');
      expect(view.url).toBeNull();
      expect(view.expiresAt).toBeNull();
      // The grant minter itself refuses, so nothing can sign around this.
      expect(() => service.signedPath('doc-1', 'exp-1', Date.now() + 60_000)).toThrow(
        ServiceUnavailableException,
      );
    });
  });

  it('keeps a signature valid across independently constructed instances and a restart', async () => {
    await withSigningKey(SIGNING_KEY, async () => {
      const exp = Date.now() + 60_000;
      const first = readyExport();
      const second = readyExport();
      const issuing = new HillDayExportService(
        first.prisma as never,
        first.documents as never,
        {} as never,
      );
      const restarted = new HillDayExportService(
        second.prisma as never,
        second.documents as never,
        {} as never,
      );
      const path = issuing.signedPath('doc-1', 'exp-1', exp);
      const sig = new URL(`https://x${path}`).searchParams.get('sig')!;
      expect(restarted.signedPath('doc-1', 'exp-1', exp)).toBe(path);
      await expect(restarted.file('doc-1', 'exp-1', String(exp), sig)).resolves.toEqual({
        buffer: first.file,
        filename: 'x.pdf',
      });
    });
  });

  it('refuses a signature minted under a different dedicated key', async () => {
    const exp = Date.now() + 60_000;
    const path = await withSigningKey(SIGNING_KEY, () => {
      const { prisma, documents } = readyExport();
      return new HillDayExportService(prisma as never, documents as never, {} as never).signedPath(
        'doc-1',
        'exp-1',
        exp,
      );
    });
    const sig = new URL(`https://x${path}`).searchParams.get('sig')!;
    await withSigningKey('synthetic-other-export-signing-key', async () => {
      const { prisma, documents } = readyExport();
      const other = new HillDayExportService(prisma as never, documents as never, {} as never);
      await expect(other.file('doc-1', 'exp-1', String(exp), sig)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
