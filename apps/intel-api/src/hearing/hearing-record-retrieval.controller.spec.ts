import { HearingRecordRetrievalController } from './hearing-record-retrieval.controller.js';
const body = {
  tenantId: 'tenant-a',
  actor: 'owner-a',
  eventId: 'event-a',
  view: 'briefs',
  id: 'brief-a',
  clientId: 'client-a',
};
describe('governed owner published-record reads', () => {
  const original = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-internal-secret';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = original;
  });
  function fixture() {
    const brief = {
        id: 'brief-a',
        createdAt: new Date('2026-09-01'),
        approvedAt: new Date('2026-09-12'),
        contentHash: 'content',
        payload: { clientId: 'client-a', sourceHash: 'source' },
        current: true,
      },
      run = {
        current: true,
        createdAt: new Date('2026-09-01'),
        payload: { observation: { clientId: 'client-a' } },
        assessments: [
          {
            reviews: [
              { createdAt: new Date('2026-09-03'), rationale: 'Earlier review' },
              { createdAt: new Date('2026-09-12'), rationale: 'Later review' },
            ],
          },
        ],
      };
    const workflow = {
      authorize: jest.fn(async () => {}),
      brief: jest.fn(async () => structuredClone(brief)),
      approvedDocument: jest.fn(async () => ({})),
      run: jest.fn(async () => structuredClone(run)),
      actor: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn({ $queryRaw: async () => [{ created_at: new Date('2026-09-03') }] }),
      ),
    };
    return {
      brief,
      run,
      workflow,
      controller: new HearingRecordRetrievalController(workflow as never),
    };
  }
  it('accepts the earlier approval as of the requested date after a later renewal', async () => {
    const f = fixture();
    const result = (await f.controller.retrieve('synthetic-internal-secret', {
      ...body,
      asOf: '2026-09-04',
    })) as { approvedAt: Date; historical: boolean };
    expect(result.approvedAt.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(result.historical).toBe(true);
  });
  it('excludes later assessment reviews from an explicit historical reconciliation', async () => {
    const f = fixture();
    const result = (await f.controller.retrieve('synthetic-internal-secret', {
      ...body,
      view: 'reconciliation',
      asOf: '2026-09-04',
    })) as { assessments: Array<{ reviews: Array<{ rationale: string }> }> };
    expect(result.assessments[0]!.reviews.map((r) => r.rationale)).toEqual(['Earlier review']);
  });
  it('rejects stale default reads and cross-client private reads', async () => {
    const f = fixture();
    f.brief.current = false;
    await expect(f.controller.retrieve('synthetic-internal-secret', body)).rejects.toThrow(
      'CURRENT_REVIEWED_BRIEF_REQUIRED',
    );
    f.brief.current = true;
    await expect(
      f.controller.retrieve('synthetic-internal-secret', { ...body, clientId: 'other-client' }),
    ).rejects.toThrow('EXACT_AUTHORIZED_CLIENT_REQUIRED');
    f.run.current = false;
    await expect(
      f.controller.retrieve('synthetic-internal-secret', { ...body, view: 'reconciliation' }),
    ).rejects.toThrow('CURRENT_RECONCILIATION_REQUIRED');
  });
  it('requires authenticated service identity before any owner lookup', async () => {
    const f = fixture();
    await expect(f.controller.retrieve('wrong', body)).rejects.toThrow();
    expect(f.workflow.authorize).not.toHaveBeenCalled();
  });
  it('returns only exact access metadata and requires distribution approval for saved attachments', async () => {
    const f = fixture(),
      input = { ...body, view: 'document-access', contentHash: 'content', purpose: 'read' };
    const result = await f.controller.retrieve('synthetic-internal-secret', input);
    expect(result).toMatchObject({
      kind: 'capiro_record_document_access',
      id: 'brief-a',
      sourceHash: 'source',
    });
    expect(result).not.toHaveProperty('payload');
    await f.controller.retrieve('synthetic-internal-secret', { ...input, purpose: 'distribute' });
    expect(f.workflow.approvedDocument).toHaveBeenCalledTimes(1);
    f.workflow.approvedDocument.mockRejectedValueOnce(
      Error('RETAINED_DISTRIBUTION_PERMISSION_REVOKED') as never,
    );
    await expect(
      f.controller.retrieve('synthetic-internal-secret', { ...input, purpose: 'distribute' }),
    ).rejects.toThrow('REVOKED');
    f.brief.current = false;
    await expect(f.controller.retrieve('synthetic-internal-secret', input)).rejects.toThrow(
      'CURRENT_REVIEWED',
    );
  });
});
