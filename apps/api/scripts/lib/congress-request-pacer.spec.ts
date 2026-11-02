import { createCongressRequestPacer } from '../../src/ingestion/congress-request-pacer';
import { fetchCongressJson } from '../../src/ingestion/congress-http';
describe('bounded Congress ingestion pacing', () => {
  it('serializes concurrent attempts and enforces a total request cap', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const pacer = createCongressRequestPacer({
      limit: 3,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await Promise.all([pacer.beforeAttempt(), pacer.beforeAttempt(), pacer.beforeAttempt()]);
    expect(sleeps).toEqual([750, 750]);
    expect(pacer.count()).toBe(3);
    await expect(pacer.beforeAttempt()).rejects.toThrow('CONGRESS_REQUEST_CAP_REACHED');
  });
  it('counts and paces retries before network access and refuses the next attempt at the cap', async () => {
    let now = 0;
    const pacer = createCongressRequestPacer({
      limit: 2,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const fetchImpl = jest.fn(async () => ({
      status: 503,
      ok: false,
      statusText: 'Unavailable',
      headers: { get: () => null },
      json: async () => ({}),
    }));
    await expect(
      fetchCongressJson('https://api.congress.gov/v3/bill/119', {
        fetchImpl,
        beforeAttempt: pacer.beforeAttempt,
        sleep: async (ms) => {
          now += ms;
        },
        warn: () => {},
        maxRetries: 5,
      }),
    ).rejects.toThrow('CONGRESS_REQUEST_CAP_REACHED');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pacer.count()).toBe(2);
  });
});
