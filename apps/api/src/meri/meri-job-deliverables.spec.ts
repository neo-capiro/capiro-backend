import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import JSZip from 'jszip';
import type { TenantContext } from '@capiro/shared';
import { bulletFontSize, MeriDocgenService } from './meri-docgen.service';
import {
  deliverableFileName,
  deliverablesWithPlanTitle,
  MeriDeliverableReadBackError,
  MeriJobDeliverableRequestError,
  readBackDeliverable,
  reportSections,
  requestedJobDeliverables,
  researchReportExcelSpec,
  researchReportPptxSpec,
  researchReportWordSpec,
} from './meri-job-deliverables';
import { MeriJobDeliverablesService } from './meri-job-deliverables.service';

const REPORT = [
  '# HR 1 office brief',
  '',
  '*Deep research report - generated 2026-10-06*',
  '',
  '**Topic:** What HR 1 means for the client.',
  '',
  'HR 1 passed the House [on roll call 42](https://example.gov/vote/42).',
  'It now goes to the Senate.',
  '',
  '## Client implications',
  '- Funding rises for `PE 0605231A`.',
  '- A hearing is likely.',
  '',
  '---',
  '',
  '## Sources consulted',
  '1. Congress.gov',
].join('\n');

const MARKS_REPORT = [
  '# FY27 marks comparison',
  '',
  'The House mark exceeds the Senate mark for two of three program elements.',
  '',
  '## House versus Senate marks',
  '',
  '| Program element | FY27 request | HASC mark | SASC mark |',
  '| --- | ---: | ---: | ---: |',
  '| PE 0603203F | $72.1M | $80.0M | $72.1M |',
  '| PE 0605231A | 12,500 | 14,000 | 11,000 |',
  '| PE 0602601F \\| Space | 9.5 | 9.5 | 10.0 |',
  '',
  'Amounts are in millions unless shown otherwise.',
  '',
  '## Gaps',
  '- No HAC-D mark is recorded yet.',
].join('\n');

const docgen = new MeriDocgenService();

describe('deliverable requests', () => {
  it('records one Word document by default and none for other kinds', () => {
    expect(requestedJobDeliverables('deliverable', undefined, 'Brief')).toEqual([
      { format: 'docx', title: 'Brief', artifactId: null },
    ]);
    expect(
      requestedJobDeliverables('deliverable', [{ format: 'docx', title: ' Office brief ' }], 'x'),
    ).toEqual([{ format: 'docx', title: 'Office brief', artifactId: null }]);
    expect(requestedJobDeliverables('research', undefined, 'x')).toEqual([]);
    expect(requestedJobDeliverables('research', [], 'x')).toEqual([]);
  });

  it('records an Excel workbook or a PowerPoint deck (Release C)', () => {
    expect(
      requestedJobDeliverables('deliverable', [{ format: 'xlsx', title: 'Marks' }], 'x'),
    ).toEqual([{ format: 'xlsx', title: 'Marks', artifactId: null }]);
    expect(
      requestedJobDeliverables('deliverable', [{ format: 'pptx' }], 'Quarterly update'),
    ).toEqual([{ format: 'pptx', title: 'Quarterly update', artifactId: null }]);
  });

  it.each([
    ['research', [{ format: 'docx' }]],
    ['deliverable', [{ format: 'pdf' }]],
    ['deliverable', [{ format: 'markdown' }]],
    ['deliverable', []],
    ['deliverable', [{ format: 'docx' }, { format: 'xlsx' }]],
  ] as const)('refuses kind %s with %j', (kind, raw) => {
    expect(() => requestedJobDeliverables(kind, raw, 'x')).toThrow(MeriJobDeliverableRequestError);
  });

  it('names an untitled deliverable after the admitted plan, not the cut-off request', () => {
    // "Delegate this" sends no title, so the file was named after the request
    // text cut at the title limit (HANDOVER-2026-10-07 §3.4).
    const placeholder = 'Draft a two-page office brief on H.R. 5929 for the client, covering the House-r';
    const stored = requestedJobDeliverables('deliverable', [{ format: 'docx' }], placeholder);
    expect(deliverablesWithPlanTitle(stored, placeholder, ' H.R. 5929 office brief ')).toEqual([
      { format: 'docx', title: 'H.R. 5929 office brief', artifactId: null },
    ]);
  });

  it('keeps an explicitly requested title and reports no change', () => {
    const stored = requestedJobDeliverables('deliverable', [{ format: 'xlsx', title: 'Marks' }], 'x');
    expect(deliverablesWithPlanTitle(stored, 'x', 'Plan title')).toBeNull();
    expect(deliverablesWithPlanTitle([], 'x', 'Plan title')).toBeNull();
    expect(deliverablesWithPlanTitle(stored, 'Marks', '   ')).toBeNull();
  });
});

describe('report parsing', () => {
  it('keeps headings, paragraphs and lists as plain text', () => {
    const spec = researchReportWordSpec('HR 1 office brief', REPORT);
    expect(spec.title).toBe('HR 1 office brief');
    expect(spec.sections.map((section) => section.heading)).toEqual([
      'Summary',
      'Client implications',
      'Sources consulted',
    ]);
    expect(spec.sections[0]!.paragraphs).toEqual([
      'Deep research report - generated 2026-10-06',
      'Topic: What HR 1 means for the client.',
      'HR 1 passed the House on roll call 42 (https://example.gov/vote/42). It now goes to the Senate.',
    ]);
    expect(spec.sections[1]!.bullets).toEqual([
      'Funding rises for PE 0605231A.',
      'A hearing is likely.',
    ]);
    expect(spec.sections[2]!.bullets).toEqual(['Congress.gov']);
  });

  it('reads pipe tables as tables, not as paragraphs with pipes', () => {
    const sections = reportSections('FY27 marks comparison', MARKS_REPORT);
    const marks = sections.find((section) => section.heading === 'House versus Senate marks')!;
    expect(marks.tables).toEqual([
      {
        headers: ['Program element', 'FY27 request', 'HASC mark', 'SASC mark'],
        rows: [
          ['PE 0603203F', '$72.1M', '$80.0M', '$72.1M'],
          ['PE 0605231A', '12,500', '14,000', '11,000'],
          ['PE 0602601F | Space', '9.5', '9.5', '10.0'],
        ],
      },
    ]);
    expect(marks.paragraphs).toEqual(['Amounts are in millions unless shown otherwise.']);
    expect(JSON.stringify(sections)).not.toContain('| ---');
    expect(
      researchReportWordSpec('FY27 marks comparison', MARKS_REPORT).sections[1]!.tables,
    ).toHaveLength(1);
  });

  it('names the file safely for each format', () => {
    expect(deliverableFileName('HR 1: brief / draft')).toBe('HR 1- brief - draft.docx');
    expect(deliverableFileName('   ')).toBe('Meri deliverable.docx');
    expect(deliverableFileName('FY27 marks', 'xlsx')).toBe('FY27 marks.xlsx');
    expect(deliverableFileName('Q3 update', 'pptx')).toBe('Q3 update.pptx');
  });
});

describe('report to Excel', () => {
  it('puts each table on its own sheet, then every line of report text', () => {
    const spec = researchReportExcelSpec('FY27 marks comparison', MARKS_REPORT);
    expect(spec.sheets.map((sheet) => sheet.name)).toEqual(['House versus Senate marks', 'Report']);
    expect(spec.sheets[0]!.headers).toEqual([
      'Program element',
      'FY27 request',
      'HASC mark',
      'SASC mark',
    ]);
    expect(spec.sheets[0]!.rows).toHaveLength(3);
    expect(spec.sheets[1]!.rows).toEqual([
      ['Summary', 'The House mark exceeds the Senate mark for two of three program elements.'],
      ['House versus Senate marks', 'Amounts are in millions unless shown otherwise.'],
      ['Gaps', '• No HAC-D mark is recorded yet.'],
    ]);
  });

  it('still produces a workbook for a report without tables', () => {
    const spec = researchReportExcelSpec('HR 1 office brief', REPORT);
    expect(spec.sheets.map((sheet) => sheet.name)).toEqual(['Report']);
  });
});

describe('report to PowerPoint', () => {
  it('gives each section a slide and each table its own slides, losing no text', () => {
    const spec = researchReportPptxSpec('FY27 marks comparison', MARKS_REPORT);
    expect(spec.slides.map((slide) => slide.title)).toEqual([
      'Summary',
      'House versus Senate marks',
      'House versus Senate marks (cont.)',
      'Gaps',
    ]);
    expect(spec.slides[2]!.table?.rows).toHaveLength(3);
    const text = JSON.stringify(spec.slides);
    for (const sentence of [
      'The House mark exceeds the Senate mark',
      'Amounts are in millions',
      'No HAC-D mark is recorded yet.',
    ])
      expect(text).toContain(sentence);
  });

  it('continues long sections and long tables across slides', () => {
    const sentence = 'The committee recorded a separate mark for this element in its report. ';
    const rows = Array.from({ length: 23 }, (_, i) => `| PE ${i} | ${i} |`);
    const markdown = [
      '# Deck',
      '## Background',
      sentence.repeat(20),
      '',
      ...Array.from({ length: 8 }, (_, i) => `- Point ${i + 1}`),
      '## Data',
      '| PE | Amount |',
      '| --- | --- |',
      ...rows,
    ].join('\n');
    const spec = researchReportPptxSpec('Deck', markdown);
    const background = spec.slides.filter((slide) => slide.title.startsWith('Background'));
    expect(background.length).toBeGreaterThan(1);
    expect(background.every((slide) => slide.bullets.length <= 8)).toBe(true);
    expect(
      background.every((slide) => slide.bullets.reduce((n, b) => n + b.length, 0) <= 1_300),
    ).toBe(true);
    expect(background.flatMap((slide) => slide.bullets).join(' ')).toContain('Point 8');
    const data = spec.slides.filter((slide) => slide.title.startsWith('Data'));
    expect(data.map((slide) => slide.table?.rows.length)).toEqual([10, 10, 3]);
  });

  // T12 (session 6904f9d7, 2026-10-07): six report sections became 16 slides,
  // one for the provenance header and six for the source register.
  const ASSEMBLED = [
    '# Quarterly update',
    '',
    '*Deep research report · generated 2026-10-07*',
    '',
    '**Topic:** Make a six-slide quarterly update deck for this client.',
    '',
    ...['Executive Summary', 'Objectives', 'Engagement', 'Evidence', 'Gaps', 'Actions'].flatMap(
      (heading, i) => [
        `## ${heading}`,
        ...Array.from({ length: 5 }, (_, j) => `- Point ${i}.${j} ${'x'.repeat(150)}`),
        '',
      ],
    ),
    '## Sources consulted',
    ...Array.from(
      { length: 26 },
      (_, i) =>
        `- [${i + 1}] Source ${i + 1} — ${'a long description of what this source says. '.repeat(4)}`,
    ),
  ].join('\n');

  it('reads the provenance by position when the report title differs from the deliverable', () => {
    const retitled = ASSEMBLED.replace(
      '# Quarterly update',
      '# Research for a sourced quarterly update',
    );
    const spec = researchReportPptxSpec('Quarterly update', retitled);
    expect(spec.subtitle).toBe('Deep research report · generated 2026-10-07');
    expect(spec.slides[0]!.title).toBe('Executive Summary');
    expect(spec.slides.map((slide) => slide.title)).not.toContain(
      'Research for a sourced quarterly update',
    );
  });

  it('keeps a first section that has content besides provenance', () => {
    const spec = researchReportPptxSpec('FY27 marks comparison', MARKS_REPORT);
    expect(spec.slides[0]!.title).toBe('Summary');
    expect(spec.subtitle).toBeNull();
  });

  it('puts the provenance on the title slide and the request in its notes', () => {
    const spec = researchReportPptxSpec('Quarterly update', ASSEMBLED);
    expect(spec.subtitle).toBe('Deep research report · generated 2026-10-07');
    expect(spec.titleNotes).toBe('Topic: Make a six-slide quarterly update deck for this client.');
    expect(spec.slides.map((slide) => slide.title)).not.toContain('Summary');
  });

  it('keeps a six-section report to six slides plus a compact source register', () => {
    const spec = researchReportPptxSpec('Quarterly update', ASSEMBLED);
    expect(spec.slides.map((slide) => slide.title)).toEqual([
      'Executive Summary',
      'Objectives',
      'Engagement',
      'Evidence',
      'Gaps',
      'Actions',
      'Sources consulted',
      'Sources consulted (cont.)',
      'Sources consulted (cont.)',
    ]);
    const sources = spec.slides.filter((slide) => slide.title.startsWith('Sources'));
    expect(sources[0]!.bullets[0]).toBe('[1] Source 1');
    expect(sources.map((slide) => slide.bullets.length)).toEqual([12, 12, 2]);
    // Every full source entry is kept, in the speaker notes.
    const notes = sources.map((slide) => slide.notes).join('\n');
    for (let i = 1; i <= 26; i += 1)
      expect(notes).toContain(`[${i}] Source ${i} — a long description`);
  });

  it('writes the speaker notes into the deck', async () => {
    const spec = researchReportPptxSpec('Quarterly update', ASSEMBLED);
    const zip = await JSZip.loadAsync(await docgen.buildPptx(spec));
    const notes = Object.keys(zip.files).filter((name) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name),
    );
    expect(notes.length).toBeGreaterThanOrEqual(4);
    const all = (await Promise.all(notes.map((name) => zip.file(name)!.async('string')))).join('');
    expect(all).toContain('[26] Source 26');
    expect(all).toContain('Topic: Make a six-slide quarterly update deck');
    await expect(
      readBackDeliverable('pptx', await docgen.buildPptx(spec), {
        title: spec.title,
        slides: spec.slides.length + 1,
      }),
    ).resolves.toMatchObject({ parts: 10 });
  });

  it('sizes slide text down before a section has to continue', () => {
    expect(bulletFontSize(['x'.repeat(600)])).toBe(16);
    expect(bulletFontSize(['x'.repeat(500), 'y'.repeat(400)])).toBe(14);
    expect(bulletFontSize(['x'.repeat(1_250)])).toBe(12);
  });
});

describe('read-back of produced files', () => {
  it('accepts real Word, Excel and PowerPoint files and counts their parts', async () => {
    const word = researchReportWordSpec('FY27 marks comparison', MARKS_REPORT);
    await expect(
      readBackDeliverable('docx', await docgen.buildDocx(word), { title: word.title }),
    ).resolves.toMatchObject({ parts: 1 });
    const excel = researchReportExcelSpec('FY27 marks comparison', MARKS_REPORT);
    await expect(
      readBackDeliverable('xlsx', await docgen.buildXlsx(excel), { title: excel.title, sheets: 2 }),
    ).resolves.toMatchObject({ parts: 2 });
    const deck = researchReportPptxSpec('FY27 marks comparison', MARKS_REPORT);
    await expect(
      readBackDeliverable('pptx', await docgen.buildPptx(deck), {
        title: deck.title,
        slides: deck.slides.length + 1,
      }),
    ).resolves.toMatchObject({ parts: 5 });
  });

  it('refuses bytes that are not the requested Office container', async () => {
    await expect(
      readBackDeliverable('docx', Buffer.from('docx-bytes'), { title: 'x' }),
    ).rejects.toBeInstanceOf(MeriDeliverableReadBackError);
    const notWord = new JSZip();
    notWord.file('[Content_Types].xml', '<Types/>');
    notWord.file('hello.txt', 'hi');
    const zipped = await notWord.generateAsync({ type: 'nodebuffer' });
    await expect(readBackDeliverable('docx', zipped, { title: 'x' })).rejects.toThrow(
      'missing word/document.xml',
    );
    const excel = researchReportExcelSpec('FY27 marks comparison', MARKS_REPORT);
    await expect(
      readBackDeliverable('xlsx', await docgen.buildXlsx(excel), { title: excel.title, sheets: 3 }),
    ).rejects.toThrow('2 sheets, expected 3');
    const word = researchReportWordSpec('HR 1 office brief', REPORT);
    await expect(
      readBackDeliverable('docx', await docgen.buildDocx(word), { title: 'A different title' }),
    ).rejects.toThrow('the title is not in the document');
  });

  it('finds a title with quotes and ampersands in the Word text', async () => {
    const title = 'R&D "marks" <FY27>';
    const word = researchReportWordSpec(title, REPORT);
    await expect(
      readBackDeliverable('docx', await docgen.buildDocx(word), { title: word.title }),
    ).resolves.toMatchObject({ parts: 1 });
  });
});

describe('deliverable service', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
  const JOB = '11111111-1111-4111-8111-111111111111';

  function harness(
    options: {
      kind?: string;
      clientId?: string | null;
      jobs?: boolean;
      artifactId?: string | null;
      filedExists?: boolean;
      reportError?: Error;
      format?: string;
      title?: string;
      markdown?: string;
      docgen?: Partial<MeriDocgenService>;
    } = {},
  ) {
    const session = {
      id: JOB,
      kind: options.kind ?? 'deliverable',
      clientId: options.clientId === undefined ? 'client-1' : options.clientId,
      deliverables: [
        {
          format: options.format ?? 'docx',
          title: options.title ?? 'HR 1 office brief',
          artifactId: options.artifactId ?? null,
        },
      ],
      metadata: {
        handoff: { version: 1, conversationId: 'conversation-1', messages: [], attachments: [] },
      },
    };
    const tx = {
      clioResearchSession: {
        findFirst: jest.fn(async () => session),
        update: jest.fn(async ({ data }: { data: { deliverables: unknown } }) => {
          session.deliverables = data.deliverables as typeof session.deliverables;
          return session;
        }),
      },
      tenant: {
        findFirst: jest.fn(async () => ({
          settings: { clioFeatureFlags: { 'meri.jobs': options.jobs ?? true } },
        })),
      },
      engagementAttachment: {
        findFirst: jest.fn(async () =>
          options.filedExists
            ? { id: options.artifactId, fileName: 'HR 1 office brief.docx' }
            : null,
        ),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    const research = {
      getReportMarkdown: jest.fn(async () => {
        if (options.reportError) throw options.reportError;
        return { title: 'Report', markdown: options.markdown ?? REPORT };
      }),
    };
    const generator = {
      buildDocx: jest.fn((spec) => docgen.buildDocx(spec)),
      buildXlsx: jest.fn((spec) => docgen.buildXlsx(spec)),
      buildPptx: jest.fn((spec) => docgen.buildPptx(spec)),
      ...options.docgen,
    };
    const filing = {
      saveJobDeliverable: jest.fn(async () => ({
        status: 'saved' as const,
        documentId: 'document-1',
        fileName: 'HR 1 office brief.docx',
        location: '/clients?clientId=client-1&tab=files&attachmentId=document-1',
        reused: false,
      })),
    };
    const service = new MeriJobDeliverablesService(
      prisma as never,
      research as never,
      generator as never,
      filing as never,
    );
    return { service, session, tx, research, docgen: generator, filing };
  }

  it('renders the Word document from the authorized report only', async () => {
    const h = harness();
    const document = await h.service.docx(ctx, JOB, 0);
    expect(h.research.getReportMarkdown).toHaveBeenCalledWith(ctx, JOB);
    expect(document.fileName).toBe('HR 1 office brief.docx');
    expect(document.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(document.buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const withheld = harness({ reportError: new BadRequestException('held for review') });
    await expect(withheld.service.docx(ctx, JOB, 0)).rejects.toThrow('held for review');
    expect(withheld.docgen.buildDocx).not.toHaveBeenCalled();
  });

  it.each([
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'buildXlsx'],
    [
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'buildPptx',
    ],
  ] as const)(
    'renders a %s deliverable as a verified Office file',
    async (format, mime, builder) => {
      const h = harness({ format, title: 'FY27 marks comparison', markdown: MARKS_REPORT });
      const document = await h.service.render(ctx, JOB, 0, format);
      expect(document).toMatchObject({
        fileName: `FY27 marks comparison.${format}`,
        contentType: mime,
      });
      expect(h.docgen[builder]).toHaveBeenCalledTimes(1);
      expect(h.docgen.buildDocx).not.toHaveBeenCalled();
      const zip = await JSZip.loadAsync(document.buffer);
      expect(
        Object.keys(zip.files).some((name) => name.startsWith(format === 'xlsx' ? 'xl/' : 'ppt/')),
      ).toBe(true);
    },
  );

  it('refuses a download path that names another format than the job asked for', async () => {
    const h = harness({ format: 'xlsx', markdown: MARKS_REPORT });
    await expect(h.service.render(ctx, JOB, 0, 'docx')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.docx(ctx, JOB, 0)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.research.getReportMarkdown).not.toHaveBeenCalled();
  });

  it('delivers nothing when the produced bytes do not read back', async () => {
    const h = harness({
      format: 'pptx',
      markdown: MARKS_REPORT,
      docgen: { buildPptx: jest.fn(async () => Buffer.from('not a deck')) },
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(h.service.render(ctx, JOB, 0, 'pptx')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      await expect(h.service.file(ctx, JOB, 0)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(h.filing.saveJobDeliverable).not.toHaveBeenCalled();
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({
        event: 'meri.job.deliverable.read_back_failed',
        format: 'pptx',
        reason: 'pptx: not a ZIP container',
      });
    } finally {
      error.mockRestore();
    }
  });

  it('refuses a missing deliverable or a job that is not a deliverable job', async () => {
    await expect(harness().service.docx(ctx, JOB, 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness({ kind: 'research' }).service.docx(ctx, JOB, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      harness({ format: 'markdown' }).service.render(ctx, JOB, 0),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('files once into the client Files and records the document on the job', async () => {
    const h = harness();
    const receipt = await h.service.file(ctx, JOB, 0);
    expect(receipt).toMatchObject({ status: 'saved', documentId: 'document-1' });
    expect(h.filing.saveJobDeliverable).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        conversationId: 'conversation-1',
        jobId: JOB,
        index: 0,
      }),
    );
    expect(h.session.deliverables[0]).toMatchObject({ artifactId: 'document-1' });
  });

  it('files an Excel deliverable with its own name and content type', async () => {
    const h = harness({ format: 'xlsx', title: 'FY27 marks comparison', markdown: MARKS_REPORT });
    await h.service.file(ctx, JOB, 0);
    expect(h.filing.saveJobDeliverable).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        fileName: 'FY27 marks comparison.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
  });

  it('returns the filed document on a repeat confirmation instead of filing again', async () => {
    const h = harness({ artifactId: 'document-1', filedExists: true });
    const receipt = await h.service.file(ctx, JOB, 0);
    expect(receipt).toMatchObject({ documentId: 'document-1', reused: true });
    expect(h.filing.saveJobDeliverable).not.toHaveBeenCalled();
    expect(h.research.getReportMarkdown).not.toHaveBeenCalled();
  });

  it('refuses filing while meri.jobs is off or for a job without a client', async () => {
    await expect(harness({ jobs: false }).service.file(ctx, JOB, 0)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(harness({ clientId: null }).service.file(ctx, JOB, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
