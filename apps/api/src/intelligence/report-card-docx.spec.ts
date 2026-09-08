import JSZip from 'jszip';
import { renderReportCardDocx, reportCardFilename } from './report-card-docx.js';
import type { ReportCardData } from './report-card.service.js';

/**
 * The renderer is pure (no network, no DB). Same assertion style as
 * artifact-docx.spec.ts: a real .docx is a ZIP (OOXML container), so its
 * bytes must start with the `PK` local-file header, and it must never throw
 * on the bounded/empty-field shapes generateReportCard can actually produce.
 */

const FULL: ReportCardData = {
  client: { id: 'client-1', name: 'Overland AI', sectorTag: 'Defense' },
  tenant: { name: 'Acme Government Affairs', logoS3Key: null },
  period: {
    start: new Date('2026-06-01T00:00:00.000Z'),
    end: new Date('2026-08-30T00:00:00.000Z'),
    label: 'Trailing 90 days (Jun 1, 2026 – Aug 30, 2026)',
  },
  activity: {
    meetings: 6,
    uniqueRoles: ['Legislative Director', 'Chief of Staff'],
    outreachSent: 12,
    outreachOpenRate: 0.75,
    tasksCompleted: 4,
    debriefsFiled: 3,
    mailThreads: 9,
  },
  intelligence: {
    billsTracked: 5,
    billsByStatus: { introduced: 2, committee: 3 },
    relatedOrganizationCount: 2,
    coverage: {
      trackedBills: 'Current curated client board',
      relatedOrganizations:
        'Shared issue codes across all available years; not verified competitors.',
      lobbying: 'Stored filings, 2021–2026; amendments may overlap.',
      contracting: 'Confirmed mapped entity; reporting window not supplied.',
    },
    lobbySpend: 180_000,
    contractWins: 4_200_000,
  },
  outcomes: [
    {
      title: 'PE 0602308A mark increase',
      fiscalYear: '2027',
      outcomeType: 'won',
      capability: 'Autonomy stack',
      notes: 'HASC added $12M over request.',
    },
  ],
  healthTrend: [
    { week: '2026-08-16', score: 62 },
    { week: '2026-08-23', score: 74 },
  ],
  aiForwardLook: 'Paragraph one.\n\nParagraph two.',
  generatedAt: '2026-08-30T00:00:00.000Z',
};

describe('renderReportCardDocx', () => {
  it('renders a valid .docx (ZIP) buffer from a full report card', async () => {
    const buf = await renderReportCardDocx(FULL);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('uses a page footer so the confidentiality line cannot become a separate body page', async () => {
    const zip = await JSZip.loadAsync(await renderReportCardDocx(FULL));
    const document = await zip.file('word/document.xml')!.async('string');
    const footer = await zip.file('word/footer1.xml')!.async('string');
    expect(document).toContain('w:footerReference');
    expect(document).not.toContain('Prepared by Acme Government Affairs');
    expect(footer).toContain('Prepared by Acme Government Affairs');
    expect(footer).toContain('Confidential');
  });

  it('keeps the generated date aligned with UTC report dates regardless of the server timezone', async () => {
    const previousZone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const zip = await JSZip.loadAsync(await renderReportCardDocx(FULL));
      const document = await zip.file('word/document.xml')!.async('string');
      expect(document).toContain('August 30, 2026');
      expect(document).not.toContain('August 29, 2026');
    } finally {
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });

  it('does not throw when outcomes, health trend and forward-look are all empty', async () => {
    const empty: ReportCardData = {
      ...FULL,
      client: { ...FULL.client, sectorTag: null },
      intelligence: { ...FULL.intelligence, billsByStatus: {} },
      outcomes: [],
      healthTrend: [],
      aiForwardLook: '',
    };
    const buf = await renderReportCardDocx(empty);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('exports honest metric definitions, coverage and normalized fiscal-year/status labels', async () => {
    const data = {
      ...FULL,
      intelligence: { ...FULL.intelligence, billsTracked: 3, relatedOrganizationCount: 22_215 },
      outcomes: [{ ...FULL.outcomes[0]!, fiscalYear: 'FY27', outcomeType: 'under_review' }],
    };
    const zip = await JSZip.loadAsync(await renderReportCardDocx(data));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Bills tracked: ');
    expect(xml).toContain('Related LDA organization records');
    expect(xml).toContain('22215');
    expect(xml).not.toContain('Competitor filings tracked');
    expect(xml).toContain('FY27');
    expect(xml).not.toContain('FYFY');
    expect(xml).toContain('Under review');
    expect(xml).not.toContain('under_review');
    expect(xml).toContain(
      'Zero recorded activity is not evidence of no engagement or diminished influence',
    );
    expect(xml).toContain('amendments may overlap');
    expect(xml).toContain('reporting window not supplied');
    expect(xml).toContain('Recorded activity index');
    expect(xml).toContain('not a measure of influence');
    expect(xml).toContain('update date does not establish when an outcome occurred');
    expect(xml).toContain('Completed task records updated');
    expect(xml).toContain('update date does not establish when they were completed');
    expect(xml).not.toContain('Tasks completed:');
  });

  it('prints unavailable metrics without inventing zero dollar totals', async () => {
    const data = {
      ...FULL,
      intelligence: {
        ...FULL.intelligence,
        billsTracked: null,
        relatedOrganizationCount: null,
        lobbySpend: null,
        contractWins: null,
      },
    };
    const zip = await JSZip.loadAsync(await renderReportCardDocx(data));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml.match(/Unavailable/g)).toHaveLength(4);
    expect(xml).not.toContain('$0');
  });

  it('does not throw when the tenant name is blank', async () => {
    const noTenant: ReportCardData = { ...FULL, tenant: { name: '', logoS3Key: null } };
    await expect(renderReportCardDocx(noTenant)).resolves.toBeInstanceOf(Buffer);
  });
});

describe('reportCardFilename', () => {
  it('slugifies the client name and stamps the period end date', () => {
    expect(reportCardFilename(FULL)).toBe('overland-ai-report-card-2026-08-30.docx');
  });

  it('falls back to a safe name for a client name with no alphanumerics', () => {
    expect(reportCardFilename({ ...FULL, client: { ...FULL.client, name: '★★★' } })).toBe(
      'client-report-card-2026-08-30.docx',
    );
  });
});
