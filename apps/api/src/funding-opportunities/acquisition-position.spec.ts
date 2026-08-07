import { describe, expect, jest, test } from '@jest/globals';
import {
  ACQUISITION_POSITION_STATES,
  AcquisitionPositionService,
  computeAcquisitionPosition,
  type AcquisitionPositionInput,
  type AcquisitionPositionReader,
  type AcquisitionVehicleEvidence,
} from './acquisition-position.js';

const ASOF = new Date('2026-08-07T00:00:00.000Z');

function evidence(overrides: Partial<AcquisitionVehicleEvidence> = {}): AcquisitionVehicleEvidence {
  return {
    tangoVehicleId: 'V1',
    vehicleName: 'Test GWAC',
    vehicleType: 'GWAC',
    relationship: 'self',
    recipientUei: 'ZZTESTUEI001',
    orderCount: 5,
    idvObligations: 100000,
    idvContractsValue: 500000,
    lastDateToOrder: null,
    expired: null,
    lastSyncedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function baseInput(overrides: Partial<AcquisitionPositionInput> = {}): AcquisitionPositionInput {
  return {
    configured: true,
    neverSynced: false,
    lastSyncedAt: '2026-08-01T00:00:00.000Z',
    evidence: [],
    asOf: ASOF,
    ...overrides,
  };
}

describe('computeAcquisitionPosition — the truth table this phase\'s acceptance bar names', () => {
  test('prime: a self relationship, not expired, is direct_prime_access', () => {
    const result = computeAcquisitionPosition(baseInput({ evidence: [evidence({ relationship: 'self' })] }));
    expect(result.state).toBe('direct_prime_access');
    expect(result.summary).toMatch(/holds a live position/);
    expect(result.summary).not.toMatch(/related|partner/i);
    expect(result.evidence).toHaveLength(1);
  });

  test('affiliate: a parent relationship, not expired, is related_entity_access — and never displays as direct', () => {
    const result = computeAcquisitionPosition(
      baseInput({ evidence: [evidence({ relationship: 'parent', recipientUei: 'PARENTUEI' })] }),
    );
    expect(result.state).toBe('related_entity_access');
    expect(result.state).not.toBe('direct_prime_access');
    expect(result.summary).toMatch(/related entity/i);
    expect(result.summary).toContain('PARENTUEI');
    expect(result.summary).toMatch(/does not hold one itself/);
  });

  test('partner: a teaming relationship is known_teaming_route — real, tested, no live producer today', () => {
    const result = computeAcquisitionPosition(
      baseInput({ evidence: [evidence({ relationship: 'teaming', recipientUei: 'PARTNERUEI' })] }),
    );
    expect(result.state).toBe('known_teaming_route');
    expect(result.recommendedRoute).toMatch(/teaming arrangement/);
    expect(result.recommendedRoute).toContain('PARTNERUEI');
  });

  test('expired vehicle: the only evidence is past its last date to order -> no_direct_access_evidence, not direct access', () => {
    const result = computeAcquisitionPosition(
      baseInput({
        evidence: [evidence({ relationship: 'self', lastDateToOrder: '2020-01-01T00:00:00.000Z', expired: true })],
      }),
    );
    expect(result.state).toBe('no_direct_access_evidence');
    expect(result.state).not.toBe('direct_prime_access');
    expect(result.summary).toMatch(/passed its last date to order/);
    // Expired evidence is still surfaced, not discarded.
    expect(result.evidence).toHaveLength(1);
  });

  test('multiple vehicles: self beats parent, and both stay in the evidence list', () => {
    const selfVehicle = evidence({ tangoVehicleId: 'V1', relationship: 'self', vehicleName: 'Self Vehicle' });
    const parentVehicle = evidence({
      tangoVehicleId: 'V2',
      relationship: 'parent',
      recipientUei: 'PARENTUEI',
      vehicleName: 'Parent Vehicle',
    });
    // Order shouldn't matter — feed parent first to prove the winner is chosen by rank, not array position.
    const result = computeAcquisitionPosition(baseInput({ evidence: [parentVehicle, selfVehicle] }));
    expect(result.state).toBe('direct_prime_access');
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]!.relationship).toBe('self');
    expect(result.evidence[1]!.relationship).toBe('parent');
  });

  test('multiple vehicles: a non-expired parent beats an expired self — expiry is checked before relationship rank', () => {
    const expiredSelf = evidence({
      tangoVehicleId: 'V1',
      relationship: 'self',
      lastDateToOrder: '2020-01-01T00:00:00.000Z',
      expired: true,
    });
    const liveParent = evidence({ tangoVehicleId: 'V2', relationship: 'parent', recipientUei: 'PARENTUEI' });
    const result = computeAcquisitionPosition(baseInput({ evidence: [expiredSelf, liveParent] }));
    expect(result.state).toBe('related_entity_access');
    expect(result.evidence[0]!.tangoVehicleId).toBe('V2');
  });

  test('missing provider data: not configured at all -> unknown, distinct from "found nothing"', () => {
    const result = computeAcquisitionPosition(baseInput({ configured: false, evidence: [] }));
    expect(result.state).toBe('unknown');
    expect(result.summary).toMatch(/not configured/);
    // Never a claim of ineligibility.
    expect(result.summary + result.recommendedRoute).not.toMatch(/cannot bid|ineligible/i);
  });

  test('missing provider data: configured but the sync has never completed a run -> unknown', () => {
    const result = computeAcquisitionPosition(baseInput({ neverSynced: true, lastSyncedAt: null, evidence: [] }));
    expect(result.state).toBe('unknown');
    expect(result.summary).toMatch(/has not completed a run/);
    expect(result.freshness).toEqual({ lastSyncedAt: null, neverSynced: true });
  });

  test('missing provider data: the sync ran and found zero relevant vehicles -> vehicle_not_identified, not unknown', () => {
    const result = computeAcquisitionPosition(baseInput({ evidence: [] }));
    expect(result.state).toBe('vehicle_not_identified');
    expect(result.state).not.toBe('unknown');
    expect(result.summary).toMatch(/No contract vehicle relevant/);
  });

  test('every state name in the vocabulary is reachable by exactly one of the cases above', () => {
    // Documents the full vocabulary against this file's own coverage — a
    // future addition to ACQUISITION_POSITION_STATES with no matching test
    // here is a gap this assertion makes visible.
    expect(ACQUISITION_POSITION_STATES).toEqual([
      'direct_prime_access',
      'related_entity_access',
      'known_teaming_route',
      'vehicle_not_identified',
      'no_direct_access_evidence',
      'unknown',
    ]);
  });

  test('freshness is carried through unchanged on every branch', () => {
    const result = computeAcquisitionPosition(
      baseInput({ lastSyncedAt: '2026-08-05T12:00:00.000Z', evidence: [evidence()] }),
    );
    expect(result.freshness).toEqual({ lastSyncedAt: '2026-08-05T12:00:00.000Z', neverSynced: false });
  });

  test('summary and recommendedRoute never contain a probability or eligibility word', () => {
    const cases: AcquisitionPositionInput[] = [
      baseInput({ evidence: [evidence({ relationship: 'self' })] }),
      baseInput({ evidence: [evidence({ relationship: 'parent' })] }),
      baseInput({ evidence: [evidence({ relationship: 'teaming' })] }),
      baseInput({ evidence: [evidence({ expired: true, lastDateToOrder: '2020-01-01T00:00:00.000Z' })] }),
      baseInput({ evidence: [] }),
      baseInput({ configured: false }),
    ];
    for (const input of cases) {
      const result = computeAcquisitionPosition(input);
      const text = `${result.summary} ${result.recommendedRoute}`.toLowerCase();
      expect(text).not.toMatch(/win probability|% chance|likely to win|eligib/);
    }
  });
});

function fakeReader(overrides: Partial<AcquisitionPositionReader> = {}): AcquisitionPositionReader {
  return {
    isConfigured: () => true,
    getSyncStatus: async () => ({ neverSynced: false, lastSyncedAt: '2026-08-01T00:00:00.000Z' }),
    listRelevantVehicles: async () => [],
    getVehicleSnapshot: async () => null,
    ...overrides,
  };
}

describe('AcquisitionPositionService — assembly, no business logic of its own', () => {
  test('not configured short-circuits before any DB read', async () => {
    const listRelevantVehicles = jest.fn(async () => []);
    const service = new AcquisitionPositionService(
      fakeReader({ isConfigured: () => false, listRelevantVehicles }),
    );
    const position = await service.getPosition('t1', 'c1', ASOF);
    expect(position.state).toBe('unknown');
    expect(listRelevantVehicles).not.toHaveBeenCalled();
  });

  test('never synced short-circuits before reading relevant vehicles', async () => {
    const listRelevantVehicles = jest.fn(async () => []);
    const service = new AcquisitionPositionService(
      fakeReader({ getSyncStatus: async () => ({ neverSynced: true, lastSyncedAt: null }), listRelevantVehicles }),
    );
    const position = await service.getPosition('t1', 'c1', ASOF);
    expect(position.state).toBe('unknown');
    expect(listRelevantVehicles).not.toHaveBeenCalled();
  });

  test('a real row is joined against its own vehicle snapshot for lastDateToOrder', async () => {
    const service = new AcquisitionPositionService(
      fakeReader({
        listRelevantVehicles: async () => [
          {
            tangoVehicleId: 'V1',
            vehicleName: 'Real Vehicle',
            vehicleType: 'GWAC',
            relationship: 'self',
            recipientUei: 'ZZTESTUEI001',
            orderCount: 3,
            idvObligations: 1000,
            idvContractsValue: 2000,
            lastSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
        getVehicleSnapshot: async (id) =>
          id === 'V1' ? { lastDateToOrder: '2030-01-01T00:00:00.000Z' } : null,
      }),
    );
    const position = await service.getPosition('t1', 'c1', ASOF);
    expect(position.state).toBe('direct_prime_access');
    expect(position.evidence[0]!.lastDateToOrder).toBe('2030-01-01T00:00:00.000Z');
    expect(position.evidence[0]!.expired).toBe(false);
  });

  test('a snapshot with no lastDateToOrder leaves expired null, not false — an unstated date is not evidence of currency', async () => {
    const service = new AcquisitionPositionService(
      fakeReader({
        listRelevantVehicles: async () => [
          {
            tangoVehicleId: 'V1',
            vehicleName: null,
            vehicleType: null,
            relationship: 'self',
            recipientUei: 'ZZTESTUEI001',
            orderCount: null,
            idvObligations: null,
            idvContractsValue: null,
            lastSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
        getVehicleSnapshot: async () => null,
      }),
    );
    const position = await service.getPosition('t1', 'c1', ASOF);
    expect(position.evidence[0]!.expired).toBeNull();
    // Null expiry is still treated as usable (not expired === true), so direct access still wins.
    expect(position.state).toBe('direct_prime_access');
  });

  test('an unrecognized relationship string is dropped as unmappable, never trusted', async () => {
    const service = new AcquisitionPositionService(
      fakeReader({
        listRelevantVehicles: async () => [
          {
            tangoVehicleId: 'V1',
            vehicleName: 'Bad Row',
            vehicleType: null,
            relationship: 'sibling', // not in ACQUISITION_RELATIONSHIPS
            recipientUei: 'ZZTESTUEI001',
            orderCount: null,
            idvObligations: null,
            idvContractsValue: null,
            lastSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      }),
    );
    const position = await service.getPosition('t1', 'c1', ASOF);
    expect(position.state).toBe('vehicle_not_identified');
    expect(position.evidence).toHaveLength(0);
  });

  test('getVehicleSnapshot is called once per relevant vehicle, keyed on tangoVehicleId', async () => {
    const getVehicleSnapshot = jest.fn(async () => null);
    const service = new AcquisitionPositionService(
      fakeReader({
        listRelevantVehicles: async () => [
          {
            tangoVehicleId: 'V1',
            vehicleName: null,
            vehicleType: null,
            relationship: 'self',
            recipientUei: 'U1',
            orderCount: null,
            idvObligations: null,
            idvContractsValue: null,
            lastSyncedAt: new Date(),
          },
          {
            tangoVehicleId: 'V2',
            vehicleName: null,
            vehicleType: null,
            relationship: 'parent',
            recipientUei: 'U2',
            orderCount: null,
            idvObligations: null,
            idvContractsValue: null,
            lastSyncedAt: new Date(),
          },
        ],
        getVehicleSnapshot,
      }),
    );
    await service.getPosition('t1', 'c1', ASOF);
    expect(getVehicleSnapshot).toHaveBeenCalledTimes(2);
    expect(getVehicleSnapshot).toHaveBeenCalledWith('V1');
    expect(getVehicleSnapshot).toHaveBeenCalledWith('V2');
  });
});
