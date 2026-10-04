import { EventEmitter } from 'node:events';
import type { Request } from 'express';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
  withMeriToolRequestControl,
} from './meri-tool-request-control.js';

function request() {
  return Object.assign(new EventEmitter(), {
    headers: {},
    aborted: false,
    res: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }),
  }) as unknown as Request;
}

describe('Meri API tool request cancellation', () => {
  test('normal request completion is active, response disconnect stops later dispatch', async () => {
    const req = request();
    await withMeriToolRequestControl(req, async () => {
      req.emit('close');
      expect(() => assertMeriToolRequestActive()).not.toThrow();
      req.res!.emit('close');
      expect(() => assertMeriToolRequestActive()).toThrow('cancelled');
    });
    expect(req.listenerCount('aborted')).toBe(0);
    expect(req.res!.listenerCount('close')).toBe(0);
    expect(meriToolRequestControl()).toBeUndefined();
  });

  test('a deadline in the past blocks dispatch and concurrent requests are isolated', async () => {
    const req = request();
    req.headers['x-meri-deadline-at'] = String(Date.now() - 1);
    const run = jest.fn(async () => undefined);
    await expect(withMeriToolRequestControl(req, run)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(run).not.toHaveBeenCalled();
    await withMeriToolRequestControl(request(), async () =>
      expect(() => assertMeriToolRequestActive()).not.toThrow(),
    );
  });
});
