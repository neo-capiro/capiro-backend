import { preferenceHarness } from './fixtures/tracker-watchlist-ownership/prefs-io.js';
import {
  CLIENT,
  TENANT,
  USER,
  namesWithoutScopes,
} from './fixtures/tracker-watchlist-ownership/io.js';
import { shippedTriggers } from './fixtures/tracker-watchlist-ownership/literals.js';
import type { PutAlertPrefsInput } from '../src/tracker/tracker-watchlist.service.js';

it('preference read defaults are fresh and hide a foreign-tenant row', async () => {
  const h = preferenceHarness();
  h.rows.pref = { tenantId: 'foreign-tenant', smsPhone: '+12025550100', smsPhoneVerified: true };
  const first = await h.service.getAlertPrefs(TENANT, CLIENT, USER);
  expect(first).toEqual({
    clientId: CLIENT,
    userId: USER,
    triggers: shippedTriggers,
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
    jurisdictions: [],
  });
  first.triggers.push('caller mutation');
  expect((await h.service.getAlertPrefs(TENANT, CLIENT, USER)).triggers).toEqual(shippedTriggers);
});

it('same-tenant preference read returns the stored row rather than synthesizing defaults', async () => {
  const h = preferenceHarness();
  h.rows.pref = {
    tenantId: TENANT,
    smsPhone: '+12025550100',
    smsPhoneVerified: true,
    triggers: [],
  };
  expect(await h.service.getAlertPrefs(TENANT, CLIENT, USER)).toBe(h.rows.pref);
});

it('preference save guards before input getters, and waits for FOR UPDATE before its upsert', async () => {
  const h = preferenceHarness();
  const read = h.tape.pause('pref.read');
  const lock = h.tape.pause('pref.lock');
  const input = {
    get smsPhone() {
      h.tape.note('input.phone');
      return '(202) 555-0100';
    },
  };
  const request = h.service.putAlertPrefs(TENANT, CLIENT, USER, input);
  await read.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'pref.read']);
  read.release.resolve();
  await lock.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual([
    'system.client',
    'pref.read',
    'input.phone',
    'pref.lock',
  ]);
  expect(h.tape.calls.find((call) => call.name === 'pref.lock')!.args).toEqual({
    sql: 'SELECT sms_phone AS "smsPhone", sms_phone_verified AS "smsPhoneVerified" FROM intel_alert_preference WHERE tenant_id = ? AND client_id = ? AND user_id = ? FOR UPDATE',
    bindings: [TENANT, CLIENT, USER],
  });
  lock.release.resolve();
  await request;
  expect(h.tape.calls.find((call) => call.name === 'pref.lock')!.scope).toBe(2);
  expect(h.tape.calls.find((call) => call.name === 'pref.upsert')!.scope).toBe(2);
});

it.each([
  {
    name: 'same normalized verified phone',
    phone: '(202) 555-0100',
    oldPhone: '+12025550100',
    oldVerified: true,
    normalized: '+12025550100',
    verified: true,
  },
  {
    name: 'changed verified phone',
    phone: '+12025550101',
    oldPhone: '+12025550100',
    oldVerified: true,
    normalized: '+12025550101',
    verified: false,
  },
  {
    name: 'same unverified phone',
    phone: '+12025550100',
    oldPhone: '+12025550100',
    oldVerified: false,
    normalized: '+12025550100',
    verified: false,
  },
  {
    name: 'explicitly cleared phone',
    phone: null,
    oldPhone: '+12025550100',
    oldVerified: true,
    normalized: null,
    verified: false,
  },
  {
    name: 'invalid supplied phone',
    phone: 'not a phone',
    oldPhone: '+12025550100',
    oldVerified: true,
    normalized: null,
    verified: false,
  },
])(
  'locked consent preserves $name',
  async ({ phone, oldPhone, oldVerified, normalized, verified }) => {
    const h = preferenceHarness();
    h.rows.pref = { tenantId: TENANT, smsPhone: oldPhone, smsPhoneVerified: oldVerified };
    h.rows.lock = [{ smsPhone: oldPhone, smsPhoneVerified: oldVerified }];
    await h.service.putAlertPrefs(TENANT, CLIENT, USER, {
      smsPhone: phone,
      smsEnabled: true,
      jurisdictions: ['tx'],
    });
    const args = h.tape.calls.find((call) => call.name === 'pref.upsert')!.args;
    expect(args).toMatchObject({
      where: { userId_clientId: { userId: USER, clientId: CLIENT } },
      create: {
        tenantId: TENANT,
        clientId: CLIENT,
        userId: USER,
        smsPhone: normalized,
        jurisdictions: ['TX'],
      },
      update: {
        smsPhone: normalized,
        smsPhoneVerified: verified,
        smsEnabled: true,
        jurisdictions: ['TX'],
      },
    });
    expect(args).toMatchObject({
      create: expect.not.objectContaining({ smsPhoneVerified: expect.anything() }),
    });
  },
);

it.each(['omitted', 'null', 'empty'])('preference triggers honor %s input', async (kind) => {
  const h = preferenceHarness();
  const input: PutAlertPrefsInput = {};
  if (kind === 'empty') input.triggers = [];
  if (kind === 'null') Object.defineProperty(input, 'triggers', { value: null });
  await h.service.putAlertPrefs(TENANT, CLIENT, USER, input);
  expect(h.tape.calls.find((call) => call.name === 'pref.upsert')!.args).toMatchObject({
    create: { triggers: kind === 'empty' ? [] : shippedTriggers },
    update: { triggers: kind === 'empty' ? [] : shippedTriggers },
  });
});

it('foreign preference guard rejects before phone getters, lock or mutation', async () => {
  const h = preferenceHarness();
  h.rows.pref = { tenantId: 'foreign', smsPhone: null, smsPhoneVerified: false };
  const input = {
    get smsPhone(): never {
      throw new Error('foreign input must remain unread');
    },
  };
  await expect(h.service.putAlertPrefs(TENANT, CLIENT, USER, input)).rejects.toThrow(
    'Client not found',
  );
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'pref.read']);
});

it.each(['pref.lock', 'pref.upsert'])(
  'preference failure at %s aborts the mutation transaction',
  async (stage) => {
    const h = preferenceHarness();
    h.tape.failures.set(stage, new Error(stage));
    await expect(h.service.putAlertPrefs(TENANT, CLIENT, USER, {})).rejects.toThrow(stage);
    const names = namesWithoutScopes(h.tape);
    expect(names).toEqual(
      stage === 'pref.lock'
        ? ['system.client', 'pref.read', 'pref.lock']
        : ['system.client', 'pref.read', 'pref.lock', 'pref.upsert'],
    );
    expect(h.tape.calls.at(-1)).toMatchObject({ name: 'tenant.rollback', scope: 2 });
  },
);

it('phone confirmation awaits both guards then preserves the confirmed argument verbatim', async () => {
  const h = preferenceHarness();
  const read = h.tape.pause('pref.read');
  const request = h.service.markPhoneVerified(TENANT, CLIENT, USER, '+1 202 555 0100');
  await read.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'pref.read']);
  read.release.resolve();
  await request;
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'pref.read', 'pref.upsert']);
  expect(h.tape.calls.find((call) => call.name === 'pref.upsert')!.args).toEqual({
    where: { userId_clientId: { userId: USER, clientId: CLIENT } },
    update: { smsPhone: '+1 202 555 0100', smsPhoneVerified: true, smsEnabled: true },
    create: {
      tenantId: TENANT,
      clientId: CLIENT,
      userId: USER,
      triggers: shippedTriggers,
      smsPhone: '+1 202 555 0100',
      smsPhoneVerified: true,
      smsEnabled: true,
    },
  });
});
