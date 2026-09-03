import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import { HillDayExportService } from './hillday-export.service.js';
import type { HillDayDocumentView } from './hillday.types.js';

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
});

describe('HillDayExportService signed URLs', () => {
  it('serves the stored bytes for a valid signature and refuses tampering or expiry', async () => {
    const file = Buffer.from('%PDF-1.7 test');
    const prisma = {
      wsHillDayExport: {
        findFirst: jest.fn(async () => ({ id: 'exp-1', documentId: 'doc-1', status: 'ready', file, filename: 'x.pdf' })),
      },
    };
    const service = new HillDayExportService(prisma as never, {} as never, {} as never);
    const exp = Date.now() + 60_000;
    const path = service.signedPath('doc-1', 'exp-1', exp);
    const sig = new URL(`https://x${path}`).searchParams.get('sig')!;
    const served = await service.file('doc-1', 'exp-1', String(exp), sig);
    expect(served.buffer.equals(file)).toBe(true);
    expect(served.filename).toBe('x.pdf');
    await expect(service.file('doc-1', 'exp-1', String(exp), sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.file('doc-1', 'exp-1', String(Date.now() - 1), sig)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.file('doc-2', 'exp-1', String(exp), sig)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
