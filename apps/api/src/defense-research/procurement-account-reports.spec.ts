/**
 * procurement-account-reports.spec.ts — Service-layer tests for the account report route.
 *
 * Tests the procurementAccountScope guard and service.accountReports() method.
 * Uses a synthetic PrismaService mock; no DB or network.
 *
 * Run: node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit
 *        --runTestsByPath src/defense-research/procurement-account-reports.spec.ts
 *        src/defense-research/procurement-money-flow.spec.ts
 *      (cwd apps/api)
 */

import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ProcurementMoneyFlowService, procurementAccountScope } from './procurement-money-flow.service.js';
import type { ProcurementAccountReports } from '@capiro/shared';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const key = 'usaspending|award|CONT_AWD_N0002421C2106_9700_-NONE-_-NONE-';
const clock = '2026-10-31T10:00:00.000001Z';

const emptyAccountReports: ProcurementAccountReports = {
  contract: 'defproc-account-reports/v1',
  knownAt: clock,
  scope: { awardIdentityKeys: [key], includesDescendants: false },
  coverage: 'source_reported_rows_only',
  reports: [{
    awardIdentityKey: key,
    state: 'unavailable',
    snapshotId: null,
    sourceObservedAt: null,
    recordedAt: null,
    sourcePayloadSha256: null,
    sourceUrl: `https://www.usaspending.gov/award/${key.slice(18)}`,
    rows: [],
  }],
};

function accountHarness(result: ProcurementAccountReports = emptyAccountReports) {
  const query = jest.fn().mockResolvedValue([{ result }]);
  const withTenant = jest.fn((_tenant: string, work: (tx: unknown) => Promise<unknown>, _options: unknown) => work({ $queryRaw: query }));
  return { query, withTenant, service: new ProcurementMoneyFlowService({ withTenant } as never) };
}

// ── procurementAccountScope guard ────────────────────────────────────────────

describe('procurementAccountScope guard', () => {
  it('accepts valid awardIdentityKeys only', () => {
    const result = procurementAccountScope({ awardIdentityKeys: [key] });
    expect(result.awardIdentityKeys).toEqual([key]);
    expect(result.knownAt).toBeUndefined();
  });

  it('accepts valid awardIdentityKeys with knownAt', () => {
    const result = procurementAccountScope({ awardIdentityKeys: [key], knownAt: clock });
    expect(result.awardIdentityKeys).toEqual([key]);
    expect(result.knownAt).toBe(clock);
  });

  it('rejects sourceThrough (forbidden for account scope)', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: [key], sourceThrough: clock }))
      .toThrow(BadRequestException);
  });

  it('rejects includeActionDetails (forbidden for account scope)', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: [key], includeActionDetails: true }))
      .toThrow(BadRequestException);
  });

  it('rejects unknown fields', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: [key], extra: 'x' }))
      .toThrow(BadRequestException);
  });

  it('rejects empty array', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: [] })).toThrow(BadRequestException);
  });

  it('rejects 26+ keys', () => {
    const keys = Array.from({ length: 26 }, (_, n) => `usaspending|award|CONT_AWD_X${n}_9700_-NONE-_-NONE-`);
    expect(() => procurementAccountScope({ awardIdentityKeys: keys })).toThrow(BadRequestException);
  });

  it('rejects duplicate keys', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: [key, key] })).toThrow(BadRequestException);
  });

  it('rejects non-canonical key format', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: ['CONT_AWD_0001_9700_-NONE-_-NONE-'] }))
      .toThrow(BadRequestException);
  });

  it('rejects malformed knownAt (no microseconds)', () => {
    expect(() => procurementAccountScope({ awardIdentityKeys: [key], knownAt: '2026-10-31' }))
      .toThrow(BadRequestException);
  });

  it('rejects null/non-object input', () => {
    expect(() => procurementAccountScope(null)).toThrow(BadRequestException);
    expect(() => procurementAccountScope([])).toThrow(BadRequestException);
    expect(() => procurementAccountScope('string')).toThrow(BadRequestException);
  });
});

// ── service.accountReports ────────────────────────────────────────────────────

describe('service.accountReports — valid projection boundary', () => {
  it('returns the account report for a valid scope', async () => {
    const h = accountHarness();
    const result = await h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] });
    expect(result.contract).toBe('defproc-account-reports/v1');
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.state).toBe('unavailable');
  });

  it('passes knownAt as null when not provided', async () => {
    const h = accountHarness();
    await h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] });
    const [tenant, , options] = h.withTenant.mock.calls[0]!;
    expect(tenant).toBe('synthetic-tenant');
    expect(options).toMatchObject({ readOnly: true, timeoutMs: 15000 });
    expect(h.query.mock.calls[0]!.slice(1)).toEqual([[key], null]);
  });

  it('passes knownAt when provided', async () => {
    const h = accountHarness();
    await h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key], knownAt: clock });
    expect(h.query.mock.calls[0]!.slice(1)).toEqual([[key], clock]);
  });

  it('rejects malformed scope before any query', async () => {
    const h = accountHarness();
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [], knownAt: clock }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.withTenant).not.toHaveBeenCalled();
  });

  it('rejects sourceThrough in scope (400 before query)', async () => {
    const h = accountHarness();
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key], sourceThrough: clock }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.withTenant).not.toHaveBeenCalled();
  });

  it('returns 503 on DB failure (never fallback)', async () => {
    const h = accountHarness();
    h.query.mockRejectedValue(new Error('DB_ERROR'));
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps canonical scope/clock DB refusal to 400', async () => {
    const h = accountHarness();
    h.query.mockRejectedValue({ meta: { code: '22023' } });
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses wrong contract in projection output', async () => {
    const h = accountHarness({ ...emptyAccountReports, contract: 'defproc-scoped-money-flow/v1' as never });
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses null projection output', async () => {
    const h = accountHarness(null as never);
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses oversized projection output (>1MiB)', async () => {
    const oversized: ProcurementAccountReports = {
      ...emptyAccountReports,
      reports: [{ ...emptyAccountReports.reports[0]!, snapshotId: 'x'.repeat(1_100_000) }],
    };
    const h = accountHarness(oversized);
    await expect(h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('uses readOnly:true with 15s timeout — no master fallback', async () => {
    const h = accountHarness();
    await h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] });
    const [, , options] = h.withTenant.mock.calls[0]!;
    expect((options as Record<string, unknown>)['readOnly']).toBe(true);
    expect((options as Record<string, unknown>)['timeoutMs']).toBe(15000);
  });

  it('account route does not call moneyFlow or hubSummary (independent path)', async () => {
    const h = accountHarness();
    const moneyFlowSpy = jest.spyOn(h.service, 'moneyFlow');
    const hubSpy = jest.spyOn(h.service, 'hubSummary');
    await h.service.accountReports('synthetic-tenant', { awardIdentityKeys: [key] });
    expect(moneyFlowSpy).not.toHaveBeenCalled();
    expect(hubSpy).not.toHaveBeenCalled();
  });
});
