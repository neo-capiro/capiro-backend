import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  deliverableFileName,
  MeriJobDeliverableRequestError,
  requestedJobDeliverables,
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

describe('deliverable requests', () => {
  it('records one Word document for a deliverable job and none otherwise', () => {
    expect(requestedJobDeliverables('deliverable', undefined, 'Brief')).toEqual([
      { format: 'docx', title: 'Brief', artifactId: null },
    ]);
    expect(requestedJobDeliverables('deliverable', [{ format: 'docx', title: ' Office brief ' }], 'x')).toEqual([
      { format: 'docx', title: 'Office brief', artifactId: null },
    ]);
    expect(requestedJobDeliverables('research', undefined, 'x')).toEqual([]);
    expect(requestedJobDeliverables('research', [], 'x')).toEqual([]);
  });

  it.each([
    ['research', [{ format: 'docx' }]],
    ['deliverable', [{ format: 'xlsx' }]],
    ['deliverable', []],
    ['deliverable', [{ format: 'docx' }, { format: 'docx' }]],
  ] as const)('refuses kind %s with %j', (kind, raw) => {
    expect(() => requestedJobDeliverables(kind, raw, 'x')).toThrow(MeriJobDeliverableRequestError);
  });
});

describe('report to Word', () => {
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
    expect(spec.sections[1]!.bullets).toEqual(['Funding rises for PE 0605231A.', 'A hearing is likely.']);
    expect(spec.sections[2]!.bullets).toEqual(['Congress.gov']);
  });

  it('names the file safely', () => {
    expect(deliverableFileName('HR 1: brief / draft')).toBe('HR 1- brief - draft.docx');
    expect(deliverableFileName('   ')).toBe('Meri deliverable.docx');
  });
});

describe('deliverable service', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
  const JOB = '11111111-1111-4111-8111-111111111111';

  function harness(options: {
    kind?: string;
    clientId?: string | null;
    jobs?: boolean;
    artifactId?: string | null;
    filedExists?: boolean;
    reportError?: Error;
  } = {}) {
    const session = {
      id: JOB,
      kind: options.kind ?? 'deliverable',
      clientId: options.clientId === undefined ? 'client-1' : options.clientId,
      deliverables: [{ format: 'docx', title: 'HR 1 office brief', artifactId: options.artifactId ?? null }],
      metadata: { handoff: { version: 1, conversationId: 'conversation-1', messages: [], attachments: [] } },
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
          options.filedExists ? { id: options.artifactId, fileName: 'HR 1 office brief.docx' } : null,
        ),
      },
    };
    const prisma = { withTenant: jest.fn(async (_t: string, fn: (value: typeof tx) => unknown) => fn(tx)) };
    const research = {
      getReportMarkdown: jest.fn(async () => {
        if (options.reportError) throw options.reportError;
        return { title: 'Report', markdown: REPORT };
      }),
    };
    const docgen = { buildDocx: jest.fn(async () => Buffer.from('docx-bytes')) };
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
      docgen as never,
      filing as never,
    );
    return { service, session, tx, research, docgen, filing };
  }

  it('renders the Word document from the authorized report only', async () => {
    const h = harness();
    const document = await h.service.docx(ctx, JOB, 0);
    expect(h.research.getReportMarkdown).toHaveBeenCalledWith(ctx, JOB);
    expect(document.fileName).toBe('HR 1 office brief.docx');
    expect(document.buffer.toString()).toBe('docx-bytes');

    const withheld = harness({ reportError: new BadRequestException('held for review') });
    await expect(withheld.service.docx(ctx, JOB, 0)).rejects.toThrow('held for review');
    expect(withheld.docgen.buildDocx).not.toHaveBeenCalled();
  });

  it('refuses a missing deliverable or a job that is not a deliverable job', async () => {
    await expect(harness().service.docx(ctx, JOB, 1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness({ kind: 'research' }).service.docx(ctx, JOB, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('files once into the client Files and records the document on the job', async () => {
    const h = harness();
    const receipt = await h.service.file(ctx, JOB, 0);
    expect(receipt).toMatchObject({ status: 'saved', documentId: 'document-1' });
    expect(h.filing.saveJobDeliverable).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ clientId: 'client-1', conversationId: 'conversation-1', jobId: JOB, index: 0 }),
    );
    expect(h.session.deliverables[0]).toMatchObject({ artifactId: 'document-1' });
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
