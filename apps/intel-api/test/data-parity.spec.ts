import {
  compareTrackedBills,
  compareAlertPrefs,
  compareWatchlistHashes,
  evaluateDataParity,
  LIST_CAP,
  type LegacyTrackedBillRow,
  type IntelTrackedBillRow,
  type LegacyAlertPrefRow,
  type IntelAlertPrefRow,
} from '../src/tracker/data-parity.util.js';

function lBill(over: Partial<LegacyTrackedBillRow> = {}): LegacyTrackedBillRow {
  return {
    client_id: 'c1',
    tenant_id: 't1',
    bill_id: '119-hr-1',
    note: null,
    source: 'recommended',
    created_by: 'u1',
    last_seen_action_text: 'Referred to committee',
    last_seen_action_date: new Date('2026-06-01T00:00:00Z'),
    last_seen_at: new Date('2026-06-02T00:00:00Z'),
    ...over,
  };
}

function iBill(over: Partial<IntelTrackedBillRow> = {}): IntelTrackedBillRow {
  return {
    clientId: 'c1',
    tenantId: 't1',
    billId: '119-hr-1',
    note: null,
    isManual: false,
    trackedBy: 'u1',
    lastSeenActionText: 'Referred to committee',
    lastSeenActionDate: new Date('2026-06-01T00:00:00Z'),
    lastSeenAt: new Date('2026-06-02T00:00:00Z'),
    ...over,
  };
}

/** Phase 8 cutover gate: legacy↔intel data-store diff semantics. */
describe('compareTrackedBills', () => {
  it('matches identical rows and maps manual_search → isManual', () => {
    const d = compareTrackedBills(
      [lBill({ source: 'manual_search' })],
      [iBill({ isManual: true })],
    );
    expect(d).toMatchObject({ legacy: 1, intel: 1, matched: 1 });
    expect(d.legacyOnly).toEqual([]);
    expect(d.mismatched).toEqual([]);
  });

  it('flags legacy-only rows (backfill missed a row) and intel-only rows separately', () => {
    const d = compareTrackedBills([lBill(), lBill({ bill_id: '119-s-2' })], [iBill()]);
    expect(d.legacyOnly).toEqual(['c1:119-s-2']);
    expect(d.intelOnly).toEqual([]);
    const d2 = compareTrackedBills([lBill()], [iBill(), iBill({ billId: '119-s-9' })]);
    expect(d2.intelOnly).toEqual(['c1:119-s-9']);
    expect(d2.legacyOnly).toEqual([]);
  });

  it('gates on user-authored fields (note/isManual/trackedBy)…', () => {
    const d = compareTrackedBills([lBill({ note: 'client asked' })], [iBill({ note: null })]);
    expect(d.mismatched).toEqual(['c1:119-hr-1']);
    expect(d.matched).toBe(0);
  });

  it('…but watermark drift is NON-gating (detectors advance independently)', () => {
    const d = compareTrackedBills(
      [lBill()],
      [iBill({ lastSeenActionText: 'Passed House', lastSeenAt: new Date('2026-07-01T00:00:00Z') })],
    );
    expect(d.matched).toBe(1);
    expect(d.mismatched).toEqual([]);
    expect(d.watermarkDrift).toEqual(['c1:119-hr-1']);
  });
});

function lPref(over: Partial<LegacyAlertPrefRow> = {}): LegacyAlertPrefRow {
  return {
    client_id: 'c1',
    tenant_id: 't1',
    user_id: 'u1',
    triggers: ['amendment', 'new_match'],
    materiality: 'medium',
    email_enabled: true,
    email_address: 'a@b.c',
    email_cadence: 'daily',
    sms_enabled: false,
    sms_phone: null,
    sms_phone_verified: false,
    sms_cadence: 'realtime',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    ...over,
  };
}

function iPref(over: Partial<IntelAlertPrefRow> = {}): IntelAlertPrefRow {
  return {
    clientId: 'c1',
    tenantId: 't1',
    userId: 'u1',
    triggers: ['new_match', 'amendment'], // order-insensitive
    materiality: 'medium',
    emailEnabled: true,
    emailAddress: 'a@b.c',
    emailCadence: 'daily',
    smsEnabled: false,
    smsPhone: null,
    smsPhoneVerified: false,
    smsCadence: 'realtime',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    ...over,
  };
}

describe('compareAlertPrefs', () => {
  it('matches identical prefs with order-insensitive triggers', () => {
    const d = compareAlertPrefs([lPref()], [iPref()]);
    expect(d).toMatchObject({ matched: 1, legacyOnly: [], intelOnly: [], mismatched: [] });
  });

  it('flags any drifted user-set field', () => {
    const d = compareAlertPrefs([lPref()], [iPref({ emailCadence: 'weekly' })]);
    expect(d.mismatched).toEqual(['u1:c1']);
  });

  it('null and empty-string are equivalent for optional strings', () => {
    const d = compareAlertPrefs([lPref({ sms_phone: null })], [iPref({ smsPhone: null })]);
    expect(d.matched).toBe(1);
  });
});

describe('compareWatchlistHashes', () => {
  it('hash equality ⇒ matched; divergence ⇒ mismatched; presence diffs split by side', () => {
    const d = compareWatchlistHashes(
      new Map([
        ['c1', 'h1'],
        ['c2', 'h2'],
        ['c3', 'h3'],
      ]),
      new Map([
        ['c1', 'h1'],
        ['c2', 'DIFFERENT'],
        ['c4', 'h4'],
      ]),
    );
    expect(d.matched).toBe(1);
    expect(d.mismatched).toEqual(['c2']);
    expect(d.legacyOnly).toEqual(['c3']);
    expect(d.intelOnly).toEqual(['c4']);
  });
});

describe('evaluateDataParity (gate semantics)', () => {
  const emptyDiff = { legacy: 0, intel: 0, matched: 0, legacyOnly: [], intelOnly: [], mismatched: [] };
  const emptyBills = { ...emptyDiff, watermarkDrift: [] };

  it('passes when nothing is legacy-only or mismatched (intelOnly + drift allowed)', () => {
    const r = evaluateDataParity(
      'all',
      { ...emptyDiff, intelOnly: ['cX'] },
      { ...emptyBills, intelOnly: ['cY:119-hr-9'], watermarkDrift: ['cZ:119-s-1'] },
      emptyDiff,
    );
    expect(r.passed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('fails on any legacyOnly or mismatched entry, naming the store', () => {
    const r = evaluateDataParity(
      'all',
      emptyDiff,
      { ...emptyBills, legacyOnly: ['c1:119-hr-1'] },
      { ...emptyDiff, mismatched: ['u1:c1'] },
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('trackedBills.legacyOnly=1');
    expect(r.reason).toContain('alertPrefs.mismatched=1');
  });

  it('caps reported lists at LIST_CAP entries', () => {
    const many = Array.from({ length: LIST_CAP + 25 }, (_, i) => lBill({ bill_id: `119-hr-${i}` }));
    const d = compareTrackedBills(many, []);
    expect(d.legacyOnly).toHaveLength(LIST_CAP);
    expect(d.legacy).toBe(LIST_CAP + 25);
  });
});
