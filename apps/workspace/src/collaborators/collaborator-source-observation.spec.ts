import { CollaboratorsService } from './collaborators.service.js';
import { draftClientSourceAccess } from '../drafts/draft-client-access.js';
import { prospectDraftSourceAccess } from '../prospect-resources/prospect-draft-access.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../drafts/draft-client-access.js', () => ({ draftClientSourceAccess: jest.fn() }));
jest.mock('../prospect-resources/prospect-draft-access.js', () => ({ prospectDraftSourceAccess: jest.fn() }));

const savedBase = process.env.INTEL_API_BASE_URL, savedSecret = process.env.INTERNAL_SERVICE_SECRET;
const fetchMock = jest.fn();
function fixture() {
  const source = { source_key: 'saved-selection', owner_id: 'owner', source_type: 'legiwatch_research' };
  const prisma: any = { wsDraft: { findFirst: jest.fn(async () => ({ ownerId: 'owner' })) },
    $queryRaw: jest.fn(async () => [source]) };
  const service = new CollaboratorsService(prisma, {} as never);
  return { service, prisma, source, read: (strict = true) => service.sourceAccess('tenant', 'draft', 'owner', undefined, strict) };
}
beforeEach(() => {
  process.env.INTEL_API_BASE_URL = 'https://intel.invalid'; process.env.INTERNAL_SERVICE_SECRET = 'synthetic-test-secret';
  jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
  (draftClientSourceAccess as jest.Mock).mockResolvedValue(true);
  (prospectDraftSourceAccess as jest.Mock).mockResolvedValue(true);
});
afterEach(() => {
  jest.restoreAllMocks(); jest.resetAllMocks();
  if (savedBase === undefined) delete process.env.INTEL_API_BASE_URL; else process.env.INTEL_API_BASE_URL = savedBase;
  if (savedSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET; else process.env.INTERNAL_SERVICE_SECRET = savedSecret;
});
describe('strict saved-work source observation on existing authority', () => {
  it.each([true, false])('uses explicit source decision %s with matching identity', async allowed => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ allowed, selectionId: 'saved-selection' }) });
    expect(await fixture().read()).toBe(allowed);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/research-source/saved-selection/access?'),
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it.each([403, 404])('preserves definitive denied/missing source HTTP %s', async status => {
    fetchMock.mockResolvedValue({ ok: false, status }); expect(await fixture().read()).toBe(false);
  });
  it.each([401, 429, 500, 502, 503])('does not turn HTTP %s uncertainty into a complete count', async status => {
    fetchMock.mockResolvedValue({ ok: false, status });
    await expect(fixture().read()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
    expect(await fixture().read(false)).toBe(false);
  });
  it.each([null, {}, { allowed: 'true', selectionId: 'saved-selection' }, { allowed: true, selectionId: 'other' }, { allowed: false }])('rejects unbound/malformed success %j', async result => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => result });
    await expect(fixture().read()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
  });
  it.each(['network', 'redirect', 'abort', 'invalid JSON'])('withholds unresolved %s source observation', async message => {
    if (message === 'invalid JSON') fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error(message); } });
    else fetchMock.mockRejectedValue(new Error(message));
    await expect(fixture().read()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
    expect(await fixture().read(false)).toBe(false);
  });
  it('withholds missing source configuration only for strict observation', async () => {
    delete process.env.INTEL_API_BASE_URL;
    await expect(fixture().read()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
    expect(await fixture().read(false)).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves ordinary drafts, source-owner privacy, client and prospect walls', async () => {
    const f = fixture(); f.prisma.$queryRaw.mockResolvedValueOnce([]); expect(await f.read()).toBe(true);
    f.source.owner_id = 'someone-else'; expect(await f.read()).toBe(false);
    (draftClientSourceAccess as jest.Mock).mockResolvedValueOnce(false); expect(await fixture().read()).toBe(false);
    (prospectDraftSourceAccess as jest.Mock).mockResolvedValueOnce(false); expect(await fixture().read()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('propagates strict observation and abort signal through role resolution', async () => {
    const f = fixture(); const signal = AbortSignal.abort();
    fetchMock.mockImplementation(async (_url, init) => { expect(init.signal.aborted).toBe(true); throw new Error('aborted'); });
    await expect(f.service.resolveRole('tenant', 'draft', 'owner', signal, true))
      .rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
  });
});
