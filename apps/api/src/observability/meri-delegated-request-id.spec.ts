import { EventEmitter } from 'node:events';
import { ApiLatencyMiddleware } from './api-latency.middleware.js';
import { meriDelegatedRequestId } from './meri-delegated-request-id.js';

const REQUEST_ID = '3e3f72e3-70e9-4bb6-8aa7-2db3021511f9';

describe('Meri delegated HTTP correlation', () => {
  it('accepts only a bounded UUID from the untrusted header', () => {
    expect(meriDelegatedRequestId({ headers: { 'x-meri-delegated-request-id': REQUEST_ID } } as never))
      .toBe(REQUEST_ID);
    expect(meriDelegatedRequestId({ headers: { 'x-meri-delegated-request-id': 'bad\nvalue' } } as never))
      .toBeNull();
    expect(meriDelegatedRequestId({ headers: { 'x-meri-delegated-request-id': [REQUEST_ID] } } as never))
      .toBeNull();
  });

  it('logs only correlation, route, status and latency for a completed tool request', () => {
    const middleware = new ApiLatencyMiddleware();
    const log = jest.spyOn((middleware as never as { logger: { log: (line: string) => void } }).logger, 'log')
      .mockImplementation(() => undefined);
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 403;
    const next = jest.fn();
    middleware.use({
      method: 'POST', path: '/api/clio/tools/query_tasks',
      headers: { 'x-meri-delegated-request-id': REQUEST_ID, authorization: 'Bearer secret' },
    } as never, response as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    response.emit('finish');
    const event = log.mock.calls.map(([line]) => JSON.parse(line)).find((line) => line.event === 'meri.delegated_http');
    expect(event).toMatchObject({
      requestId: REQUEST_ID,
      endpoint: 'POST /api/clio/tools/:name',
      statusCode: 403,
    });
    expect(JSON.stringify(event)).not.toContain('secret');
    log.mockRestore();
  });
});
