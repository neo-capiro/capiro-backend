import { describe, expect, test } from '@jest/globals';
import { aggregateTenantScopedPeAlertWatches } from '../src/program-element/pe-alerts/tenant-watch-aggregation.js';

const USER = 'user-1';
const PE = '0603270A';
const A = 'tenant-a';
const B = 'tenant-b';

describe('send-pe-alert-emails tenant watch aggregation', () => {
  const watches = [
    { userId: USER, tenantId: A, peCode: PE, email: 'user@example.com' },
    { userId: USER, tenantId: B, peCode: PE, email: 'user@example.com' },
  ];

  test('same user and PE in two tenants creates two independent aggregates', () => {
    const result = aggregateTenantScopedPeAlertWatches(watches, [], {
      all: true,
      ids: new Set(),
    });

    expect(result).toHaveLength(2);
    expect(result.map((row) => row.key)).toEqual([`${A}:${USER}`, `${B}:${USER}`]);
    expect(result.every((row) => row.watched.has(PE))).toBe(true);
  });

  test('canary eligibility is evaluated per tenant', () => {
    const result = aggregateTenantScopedPeAlertWatches(watches, [], {
      all: false,
      ids: new Set([B]),
    });
    const byTenant = new Map(result.map((row) => [row.tenantId, row]));

    expect(byTenant.get(A)?.canaryEligible).toBe(false);
    expect(byTenant.get(B)?.canaryEligible).toBe(true);
  });

  test('off preference in tenant A does not disable tenant B', () => {
    const result = aggregateTenantScopedPeAlertWatches(
      watches,
      [
        { userId: USER, tenantId: A, mode: 'off' },
        { userId: USER, tenantId: B, mode: 'daily' },
      ],
      { all: true, ids: new Set() },
    );
    const byTenant = new Map(result.map((row) => [row.tenantId, row]));

    expect(byTenant.get(A)?.enabled).toBe(false);
    expect(byTenant.get(B)?.enabled).toBe(true);
  });
});
