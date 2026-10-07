import { PlannerLinksService } from './planner-links.service.js';
import { ConfigService } from '@nestjs/config';
describe('Planner canonical record authorization', () => {
  const fetchOriginal = global.fetch;
  const fetchMock = jest.fn();
  const service = new PlannerLinksService(
    new ConfigService({ API_INTERNAL_URL: 'https://canonical.example/' }),
  );
  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
  });
  afterAll(() => {
    global.fetch = fetchOriginal;
  });
  it('forwards only the requesting bearer to fixed canonical paths and forbids redirects', async () => {
    const cancel = jest.fn(async () => undefined);
    fetchMock.mockResolvedValue({ status: 200, ok: true, body: { cancel } });
    await service.validate({ clientId: 'client-id', meetingId: 'meeting-id' }, 'Bearer requester');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://canonical.example/api/clients/client-id',
      expect.objectContaining({
        headers: { authorization: 'Bearer requester' },
        redirect: 'error',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://canonical.example/api/engagement/meetings/meeting-id',
      expect.objectContaining({ headers: { authorization: 'Bearer requester' } }),
    );
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404])(
    'fails closed after canonical %s and releases the response body',
    async (status) => {
      const cancel = jest.fn(async () => undefined);
      fetchMock.mockResolvedValue({ status, ok: false, body: { cancel } });
      await expect(service.validate({ clientId: 'id' }, 'Bearer requester')).rejects.toMatchObject({
        status: 403,
      });
      expect(cancel).toHaveBeenCalled();
    },
  );
  it('requires user authorization and does not fall back to service access', async () => {
    await expect(service.validate({ clientId: 'id' }, undefined)).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error('redirect or network failure'));
    await expect(service.validate({ clientId: 'id' }, 'Bearer requester')).rejects.toMatchObject({
      status: 503,
    });
  });
});
