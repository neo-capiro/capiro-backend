import { notifyMeriResultObserver } from './meri-result-observer.js';

describe('Meri result observer delivery', () => {
  it('invokes once and contains a synchronous throw', () => {
    const deliver = jest.fn(() => { throw new Error('observer failed'); });

    expect(() => notifyMeriResultObserver(deliver)).not.toThrow();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when an observer never settles', () => {
    const pending = new Promise<void>(() => undefined);
    const deliver = jest.fn(() => pending);

    expect(notifyMeriResultObserver(deliver)).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('consumes an asynchronous observer rejection', async () => {
    const deliver = jest.fn(() => Promise.reject(new Error('async observer failed')));

    expect(notifyMeriResultObserver(deliver)).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
