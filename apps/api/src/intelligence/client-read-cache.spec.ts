import { ClientReadCache } from './client-read-cache.js';

describe('ClientReadCache', () => {
  function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => { now += ms; } };
  }

  it('reuses a value until its TTL expires', async () => {
    const c = clock();
    const cache = new ClientReadCache<number>(5_000, 10, c.now);
    const build = jest.fn(async () => 42);
    await expect(cache.remember('t:c', build)).resolves.toBe(42);
    c.advance(4_999);
    await expect(cache.remember('t:c', build)).resolves.toBe(42);
    expect(build).toHaveBeenCalledTimes(1);
    c.advance(1);
    await expect(cache.remember('t:c', build)).resolves.toBe(42);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight build between concurrent callers', async () => {
    const cache = new ClientReadCache<string>(60_000);
    let release!: (value: string) => void;
    const build = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = cache.remember('k', build);
    const second = cache.remember('k', build);
    expect(build).toHaveBeenCalledTimes(1);
    release('bills');
    await expect(first).resolves.toBe('bills');
    await expect(second).resolves.toBe('bills');
    expect(cache.size).toBe(1);
  });

  it('never remembers a rejected build', async () => {
    const cache = new ClientReadCache<string>(60_000);
    const failing = jest.fn(async () => { throw new Error('statement timeout'); });
    await expect(cache.remember('k', failing)).rejects.toThrow('statement timeout');
    const ok = jest.fn(async () => 'later');
    await expect(cache.remember('k', ok)).resolves.toBe('later');
    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('invalidation drops the entry and detaches an in-flight build', async () => {
    const cache = new ClientReadCache<string>(60_000);
    await cache.remember('t:a', async () => 'one');
    await cache.remember('t:b', async () => 'two');
    cache.invalidate('t:a');
    expect(cache.get('t:a')).toBeUndefined();
    expect(cache.get('t:b')).toBe('two');

    let release!: (value: string) => void;
    const slow = cache.remember('t:a', () => new Promise<string>((resolve) => { release = resolve; }));
    cache.invalidate('t:a');
    const fresh = jest.fn(async () => 'fresh');
    const after = cache.remember('t:a', fresh);
    release('stale');
    await expect(slow).resolves.toBe('stale');
    await expect(after).resolves.toBe('fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('bounds the number of entries, evicting the oldest write first', () => {
    const cache = new ClientReadCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(11);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('builds tenant-scoped keys and rejects invalid construction', () => {
    expect(ClientReadCache.key('tenant', 'client')).toBe('tenant:client');
    expect(() => new ClientReadCache(0)).toThrow(RangeError);
    expect(() => new ClientReadCache(1, 0)).toThrow(RangeError);
  });
});
