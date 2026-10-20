import { normalizeE164 } from './sms/sms.service.js';
import type { TrackerWatchlistService } from './tracker-watchlist.service.js';
import type { PutAlertPrefsInput } from './tracker-watchlist.contracts.js';
export class TrackerWatchlistPreferences {
  constructor(private readonly defaults: () => readonly string[]) {}
  async getAlertPrefs(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
    userId: string,
  ) {
    const row = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
      }),
    );
    if (row && row.tenantId === tenantId) return row;
    // P1-01: a NEW pref view returns the shipped defaults, not zero triggers. Returning
    // [] let a user save emailEnabled=true with every trigger off, so eligible()
    // (intel-alert.service.ts) matched nothing forever. markPhoneVerified already
    // seeded [...DEFAULT_TRIGGERS] on create — this makes all three paths agree.
    return {
      clientId,
      userId,
      triggers: [...this.defaults()],
      materiality: 'medium',
      emailEnabled: false,
      emailAddress: null,
      emailCadence: 'realtime',
      smsEnabled: false,
      smsPhone: null,
      smsPhoneVerified: false,
      smsCadence: 'realtime',
      quietHoursStart: null,
      quietHoursEnd: null,
      jurisdictions: [] as string[],
    };
  }
  async putAlertPrefs(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutAlertPrefsInput,
  ) {
    await host['assertClientInTenant'](tenantId, clientId);
    await host['assertPrefRowTenant'](tenantId, clientId, userId);
    const data = {
      // P1-01: `??` distinguishes an ABSENT field (undefined → default) from an
      // explicit `[]` (a deliberate clear → honor it). Do not use `||` — that
      // would silently override a user's deliberate clear-all.
      triggers: input.triggers ?? [...this.defaults()],
      materiality: input.materiality ?? 'medium',
      emailEnabled: input.emailEnabled ?? false,
      emailAddress: input.emailAddress ?? null,
      emailCadence: input.emailCadence ?? 'realtime',
      smsEnabled: input.smsEnabled ?? false,
      // Normalize like legacy putAlertPrefs — an un-normalized stored phone
      // would never match the verify flow's normalized compare.
      smsPhone: normalizeE164(input.smsPhone) ?? null,
      smsCadence: input.smsCadence ?? 'realtime',
      quietHoursStart: input.quietHoursStart ?? null,
      quietHoursEnd: input.quietHoursEnd ?? null,
      jurisdictions: Array.isArray(input.jurisdictions)
        ? input.jurisdictions.map((j) => j.toUpperCase())
        : [],
    };
    return host['prisma'].withTenant(tenantId, async (tx) => {
      // Verification belongs to one normalized phone number. Lock the
      // existing row so an OTP confirmation and a preference save cannot
      // transfer verification to a different number through a stale read.
      const [existing] = await tx.$queryRaw<
        Array<{
          smsPhone: string | null;
          smsPhoneVerified: boolean;
        }>
      >`
        SELECT sms_phone AS "smsPhone", sms_phone_verified AS "smsPhoneVerified"
        FROM intel_alert_preference
        WHERE tenant_id = ${tenantId} AND client_id = ${clientId} AND user_id = ${userId}
        FOR UPDATE
      `;
      const smsPhoneVerified = Boolean(
        data.smsPhone && existing?.smsPhoneVerified && existing.smsPhone === data.smsPhone,
      );
      return tx.intelAlertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        create: { tenantId, clientId, userId, ...data },
        update: { ...data, smsPhoneVerified },
      });
    });
  }
  /**
   * Mark a verified phone on the user's pref (P1.1, called after OTP confirm —
   * ported from apps/api tracker.service.markPhoneVerified). The confirm flow
   * is the ONLY path that grants `smsPhoneVerified` (putAlertPrefs can revoke it),
   * preserving the legacy consent contract. Client-ownership + row-tenant
   * guards mirror legacy's assertClient (cross-tenant review finding, PR-1).
   */
  async markPhoneVerified(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
    userId: string,
    phone: string,
  ): Promise<void> {
    await host['assertClientInTenant'](tenantId, clientId);
    await host['assertPrefRowTenant'](tenantId, clientId, userId);
    await host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        update: { smsPhone: phone, smsPhoneVerified: true, smsEnabled: true },
        create: {
          tenantId,
          clientId,
          userId,
          triggers: [...this.defaults()],
          smsPhone: phone,
          smsPhoneVerified: true,
          smsEnabled: true,
        },
      }),
    );
  }
}
