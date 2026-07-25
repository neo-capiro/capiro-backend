import { describe, expect, test } from '@jest/globals';
import { buildFirmNexusResponse } from './district-nexus.firm-aggregate.js';
import type { ClientNexusInputs } from './district-nexus.aggregate.js';

const GENERATED_AT = '2026-07-25T12:00:00.000Z';

function client(clientId: string, partial: Partial<ClientNexusInputs> = {}): ClientNexusInputs {
  return {
    clientId,
    contracts: [],
    assistance: [],
    opportunities: [],
    facilities: [],
    freshness: [],
    generatedAt: GENERATED_AT,
    ...partial,
  };
}

const firm = (perClient: ClientNexusInputs[]) =>
  buildFirmNexusResponse({ perClient, freshness: [], generatedAt: GENERATED_AT });

describe('firm-wide district merge', () => {
  test('two clients in one district produce one row with clientCount 2', () => {
    const res = firm([
      client('a', { contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000 }] }),
      client('b', { contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 2_500 }] }),
    ]);
    expect(res.districts).toHaveLength(1);
    expect(res.districts[0]?.districtKey).toBe('TX-23');
    expect(res.districts[0]?.clientCount).toBe(2);
    expect(res.districts[0]?.awarded.contractObligations).toBe(3_500);
  });

  test('the same client counted once however many rows it contributes', () => {
    const res = firm([
      client('a', {
        contracts: [
          { state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000 },
          { state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000 },
        ],
      }),
    ]);
    expect(res.districts[0]?.clientCount).toBe(1);
  });

  test('clients in different districts do not merge', () => {
    const res = firm([
      client('a', { contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000 }] }),
      client('b', { contracts: [{ state: 'VA', district: '11', awardCount: 1, totalAmount: 1_000 }] }),
    ]);
    expect(res.districts.map((d) => d.districtKey).sort()).toEqual(['TX-23', 'VA-11']);
    expect(res.districts.every((d) => d.clientCount === 1)).toBe(true);
  });

  test('a weak basis from one client is not laundered by a stronger one', () => {
    // The whole point of merging pessimistically: client B's recipient-location
    // grant must drag the district's grant evidence down to half weight, not be
    // hidden behind client A's place-of-performance row.
    const res = firm([
      client('a', {
        assistance: [
          {
            state: 'TX',
            district: '23',
            basis: 'place_of_performance',
            awardCount: 1,
            totalObligated: 1_000,
            totalOutlayed: 0,
          },
        ],
        facilities: [{ state: 'TX', districtCode: '23', employeeCount: 10 }],
      }),
      client('b', {
        assistance: [
          {
            state: 'TX',
            district: '23',
            basis: 'recipient_location',
            awardCount: 1,
            totalObligated: 500,
            totalOutlayed: 0,
          },
        ],
      }),
    ]);
    const d = res.districts[0]!;
    expect(d.warnings.some((w) => w.code === 'recipient_location_fallback')).toBe(true);
    expect(d.awarded.grantObligations).toBe(1_500);
  });

  test('unmapped money is summed across clients, never smeared into districts', () => {
    const res = firm([
      client('a', { contracts: [{ state: 'CA', district: '90', awardCount: 1, totalAmount: 4_000 }] }),
      client('b', { contracts: [{ state: 'CA', district: '90', awardCount: 1, totalAmount: 1_000 }] }),
    ]);
    expect(res.districts).toHaveLength(0);
    expect(res.unmapped.unmappedContractAmount).toBe(5_000);
    expect(res.warnings.some((w) => w.code === 'statewide_attribution')).toBe(true);
  });

  test('employee counts sum and unreported headcount is flagged, not zeroed', () => {
    const res = firm([
      client('a', { facilities: [{ state: 'TX', districtCode: '23', employeeCount: 400 }] }),
      client('b', { facilities: [{ state: 'TX', districtCode: '23', employeeCount: null }] }),
    ]);
    const d = res.districts[0]!;
    expect(d.employeeCount).toBe(400);
    expect(d.employeesUnreported).toBe(true);
  });

  test('a district with no headcount at all reports null, not 0', () => {
    const res = firm([
      client('a', { facilities: [{ state: 'TX', districtCode: '23', employeeCount: null }] }),
    ]);
    expect(res.districts[0]?.employeeCount).toBeNull();
  });

  test('coveragePercent is present so the map can colour by it', () => {
    const res = firm([
      client('a', { contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1 }] }),
    ]);
    // Contract place-of-performance alone: 10 of 100 weight.
    expect(res.districts[0]?.coveragePercent).toBe(10);
    // ...and below the floor, so the score is unknown rather than low.
    expect(res.districts[0]?.score).toBeNull();
  });

  test('districts are ordered strongest-first', () => {
    const res = firm([
      client('a', { contracts: [{ state: 'VA', district: '11', awardCount: 1, totalAmount: 10 }] }),
      client('b', {
        contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 10 }],
        facilities: [{ state: 'TX', districtCode: '23', employeeCount: 500 }],
      }),
    ]);
    expect(res.districts[0]?.districtKey).toBe('TX-23');
  });

  test('warnings are deduped rather than repeated once per client', () => {
    const res = firm([
      client('a', { contracts: [{ state: 'CA', district: '90', awardCount: 1, totalAmount: 1 }] }),
      client('b', { contracts: [{ state: 'CA', district: '90', awardCount: 1, totalAmount: 1 }] }),
      client('c', { contracts: [{ state: 'CA', district: '90', awardCount: 1, totalAmount: 1 }] }),
    ]);
    const statewide = res.warnings.filter((w) => w.code === 'statewide_attribution');
    expect(statewide).toHaveLength(1);
  });

  test('no clients yields an honest empty map, not a throw', () => {
    const res = firm([]);
    expect(res.districts).toEqual([]);
    expect(res.unmapped.unmappedContractAmount).toBeNull();
    expect(res.generatedAt).toBe(GENERATED_AT);
  });

  test('merging never mutates the caller inputs', () => {
    const a = client('a', {
      contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000 }],
    });
    const snapshot = JSON.stringify(a);
    firm([a, client('b', { contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1 }] })]);
    expect(JSON.stringify(a)).toBe(snapshot);
  });
});
