import { describe, expect, test } from '@jest/globals';
import { retryOnceAfterPrismaUnique } from './prisma-unique-retry.js';

function p2002(): Error & { code: string } {
  return Object.assign(new Error('unique constraint'), { code: 'P2002' });
}

describe('retryOnceAfterPrismaUnique', () => {
  test('retries exactly once after a Prisma unique race and returns the durable winner', async () => {
    let calls = 0;
    const result = await retryOnceAfterPrismaUnique(async () => {
      calls++;
      if (calls === 1) throw p2002();
      return { id: 'winner', deduped: true };
    });

    expect(result).toEqual({ id: 'winner', deduped: true });
    expect(calls).toBe(2);
  });

  test('does not retry a non-unique failure', async () => {
    let calls = 0;
    await expect(
      retryOnceAfterPrismaUnique(async () => {
        calls++;
        throw new Error('database unavailable');
      }),
    ).rejects.toThrow('database unavailable');
    expect(calls).toBe(1);
  });

  test('never retries more than once', async () => {
    let calls = 0;
    await expect(
      retryOnceAfterPrismaUnique(async () => {
        calls++;
        throw p2002();
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(calls).toBe(2);
  });
});
