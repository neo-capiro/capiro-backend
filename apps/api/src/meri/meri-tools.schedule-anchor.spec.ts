import { MeriToolsService } from './meri-tools.service';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as never;

type Normalize = (
  ctx: never,
  input: Record<string, unknown>,
) => Promise<
  | { ok: true; effect: { localAnchor: unknown; runAtMinutesUtc: number | null; fingerprint: string } }
  | { ok: false; error: string }
>;

// The private normalizer, called with stubbed dependencies (no database).
const normalize: Normalize = (context, input) =>
  (MeriToolsService.prototype as unknown as { normalizeScheduleEffect: Normalize }).normalizeScheduleEffect.call(
    {
      ensureScheduleClientAuthorized: async (_ctx: unknown, id: string) => id,
      findUserEmailConnection: async () => null,
    },
    context,
    input,
  );

const base = { name: 'Monday brief', prompt: 'Brief me on the week', intervalMinutes: 10080 };

describe('schedule_task local anchor (Release E, T10)', () => {
  it('normalizes "every Monday at 8" to a local anchor in the owner time zone', async () => {
    const result = await normalize(ctx, { ...base, localTime: '8:00', weekday: 'Monday' });
    expect(result).toMatchObject({
      ok: true,
      effect: {
        localAnchor: { localTime: '08:00', timeZone: 'America/New_York', weekday: 1 },
        runAtMinutesUtc: null,
      },
    });
  });

  it('refuses a weekly local time without a weekday', async () => {
    expect(await normalize(ctx, { ...base, localTime: '08:00' })).toEqual({
      ok: false,
      error: 'A weekly schedule with a local time needs a weekday.',
    });
  });

  it('keeps the fingerprint of a schedule without a local anchor unchanged', async () => {
    const plain = await normalize(ctx, { ...base, intervalMinutes: 1440, dailyAtUtc: '13:00' });
    const anchored = await normalize(ctx, { ...base, intervalMinutes: 1440, localTime: '08:00' });
    expect(plain.ok && anchored.ok).toBe(true);
    if (!plain.ok || !anchored.ok) return;
    expect(plain.effect.localAnchor).toBeNull();
    expect(plain.effect.runAtMinutesUtc).toBe(780);
    // The value main produced for this input before Release E (verified
    // 2026-10-07): adding the optional anchor does not re-key existing schedules.
    expect(plain.effect.fingerprint).toBe(
      'eddef6b94b8cc6ab268b1ab2a92226ed076f7872aa1b88b1a0e4d289599532df',
    );
    expect(anchored.effect.fingerprint).not.toBe(plain.effect.fingerprint);
  });
});
