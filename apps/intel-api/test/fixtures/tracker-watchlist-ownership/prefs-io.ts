import { TrackerWatchlistService } from '../../../src/tracker/tracker-watchlist.service.js';
import type { PrismaService } from '../../../src/prisma/prisma.service.js';
import { CLIENT, IoTape, scoped } from './io.js';

export interface PreferenceRow extends Record<string, unknown> {
  tenantId: string;
  smsPhone: string | null;
  smsPhoneVerified: boolean;
}
export interface PrefUpsert {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  where: unknown;
}

export function preferenceHarness() {
  const tape = new IoTape();
  const rows = {
    client: true,
    pref: null as PreferenceRow | null,
    lock: [] as Array<{ smsPhone: string | null; smsPhoneVerified: boolean }>,
  };
  const tx = {
    intelAlertPreference: {
      findUnique: (args: unknown) => tape.run('pref.read', args, rows.pref),
      upsert: (args: PrefUpsert) => tape.run('pref.upsert', args, args.create),
    },
    $queryRaw: (strings: TemplateStringsArray, ...bindings: unknown[]) =>
      tape.run(
        'pref.lock',
        { sql: strings.join('?').replace(/\s+/g, ' ').trim(), bindings },
        rows.lock,
      ),
    intelAlert: {
      findFirst: (args: unknown) => tape.run('alert.guard', args, { id: 'alert-one' }),
    },
  };
  const systemTx = {
    $queryRawUnsafe: (sql: string, ...bindings: unknown[]) =>
      tape.run('system.client', { sql, bindings }, rows.client ? [{ id: CLIENT }] : []),
  };
  const prisma = {
    withTenant: scoped(tape, tx),
    withSystem: async (callback: (tx: typeof systemTx) => unknown) => callback(systemTx),
  };
  const service = new TrackerWatchlistService(prisma as unknown as PrismaService);
  return { tape, rows, prisma, service };
}
