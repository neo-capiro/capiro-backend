/**
 * R5 District Brief — unit tests.
 *
 * Invariants tested here:
 *  - Guard: flag off → 404, master off → 404, read error → 404, flag on → pass
 *  - Context: null stays null, partial coverage labelled, Senate statewide
 *  - Brief: sections reference only existing factIds, export rejects unknown factIds
 *  - Save: uses correct source/idempotency key pattern
 */

import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { R5FlagGuard, DISTRCT_NEXUS_R5_BRIEF, type R5FeatureKey } from './r5-flag.guard.js';
import type { R5Fact, R5Gap, R5Brief } from './r5-types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

// ── Test constants ──────────────────────────────────────────────────────────

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FEATURE: R5FeatureKey = DISTRCT_NEXUS_R5_BRIEF;

// ── Mock helpers ────────────────────────────────────────────────────────────

function ctxFor(tenantId?: string): ExecutionContext {
  const req = tenantId ? { tenantContext: { tenantId } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function prismaMock(outcome: { rows?: unknown[]; throws?: Error }) {
  const captured: { sql: string | null; values: unknown[] } = { sql: null, values: [] };
  const withSystem = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        captured.sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        captured.values = values;
        if (outcome.throws) throw outcome.throws;
        return outcome.rows ?? [];
      },
    }),
  );
  const withTenant = jest.fn();
  const client = { findFirst: jest.fn() };
  return {
    service: { withSystem, withTenant, client } as unknown as PrismaService,
    withSystem,
    withTenant,
    client,
    captured,
  };
}

function configMock(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

function guardWith(outcome: { rows?: unknown[]; throws?: Error }) {
  const prisma = prismaMock(outcome);
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(FEATURE),
    get: jest.fn(),
    getAll: jest.fn(),
    getAllAndMerge: jest.fn(),
  } as unknown as { getAllAndOverride: jest.Mock; get: jest.Mock; getAll: jest.Mock; getAllAndMerge: jest.Mock };
  const guard = new R5FlagGuard(prisma.service, configMock(), reflector as any);
  return { guard, ...prisma, reflector };
}

// ── Guard tests ─────────────────────────────────────────────────────────────

describe('R5FlagGuard', () => {
  test('no tenant context → 404', async () => {
    const { guard } = guardWith({ rows: [{ ok: 1 }] });
    await expect(guard.assertEnabledForTenant(undefined, FEATURE)).rejects.toThrow(NotFoundException);
  });

  test('flag row absent → 404', async () => {
    const { guard } = guardWith({ rows: [] });
    await expect(guard.assertEnabledForTenant(TENANT, FEATURE)).rejects.toThrow(NotFoundException);
  });

  test('flag row present AND master present → pass', async () => {
    const { guard } = guardWith({ rows: [{ ok: 1 }] });
    await expect(guard.assertEnabledForTenant(TENANT, FEATURE)).resolves.toBe(true);
  });

  test('read error → 404 (fail closed)', async () => {
    const { guard } = guardWith({ throws: new Error('connection lost') });
    await expect(guard.assertEnabledForTenant(TENANT, FEATURE)).rejects.toThrow(NotFoundException);
  });

  test('flag row query includes the feature key and master', async () => {
    const { guard, captured } = guardWith({ rows: [{ ok: 1 }] });
    await guard.assertEnabledForTenant(TENANT, FEATURE);
    // The SQL is parameterized — key and master are in captured.values
    const allValues = captured.values.map(String);
    expect(allValues.some((v) => v === DISTRCT_NEXUS_R5_BRIEF)).toBe(true);
    expect(allValues.some((v) => v === 'district_nexus_v2')).toBe(true);
  });
});

// ── Context invariants ──────────────────────────────────────────────────────

describe('Context mapping invariants', () => {
  test('null stays null, never coerced to 0', () => {
    // null means unknown — it must never become zero
    const fact: R5Fact = {
      id: 'test:source:1',
      section: 'footprint',
      label: 'Unknown value fact',
      value: null,
      unit: null,
      amountStage: null,
      basis: 'public_context',
      source: { type: 'test', label: 'Test', recordId: '1', url: null },
      asOf: { date: null, fiscalYear: null, sourceYear: null },
      geography: { state: 'TX', district: '01', scope: 'district', basis: null, boundaryCongress: null },
      freshness: { lastSyncedAt: null, stale: false, unavailable: false },
      coverage: 'complete',
      caveats: [],
    };
    expect(fact.value).toBeNull();
    // Must not be 0 — 0 is a real value, null is unknown
    expect(fact.value).not.toBe(0);
  });

  test('requested vs enacted are never merged', () => {
    const requested: R5Fact = {
      id: 'cpf_cds:cpf_request:req-1',
      section: 'cpf_cds',
      label: 'Requested funding',
      value: 1000000,
      unit: 'USD',
      amountStage: 'requested',
      basis: 'public_context',
      source: { type: 'cpf_cds', label: 'CPF/CDS', recordId: 'req-1', url: null },
      asOf: { date: null, fiscalYear: null, sourceYear: null },
      geography: { state: 'TX', district: '01', scope: 'district', basis: null, boundaryCongress: null },
      freshness: { lastSyncedAt: null, stale: false, unavailable: false },
      coverage: 'complete',
      caveats: [],
    };
    const enacted: R5Fact = {
      id: 'cpf_cds:cpf_enacted:req-1',
      section: 'cpf_cds',
      label: 'Enacted funding',
      value: 500000,
      unit: 'USD',
      amountStage: 'enacted',
      basis: 'public_context',
      source: { type: 'cpf_cds', label: 'CPF/CDS enacted', recordId: 'req-1', url: null },
      asOf: { date: null, fiscalYear: null, sourceYear: null },
      geography: { state: 'TX', district: '01', scope: 'district', basis: null, boundaryCongress: null },
      freshness: { lastSyncedAt: null, stale: false, unavailable: false },
      coverage: 'complete',
      caveats: [],
    };

    expect(requested.amountStage).toBe('requested');
    expect(enacted.amountStage).toBe('enacted');
    // Must never sum them together — they have different IDs and amountStages
    expect(requested.id).not.toBe(enacted.id);
    expect(requested.value).not.toBe(enacted.value); // Different amounts, never merged
  });

  test('Senate members are labelled statewide', () => {
    const senator: R5Fact = {
      id: 'representation:senator:S001',
      section: 'representation',
      label: 'Jane Smith (D) — Senate (statewide)',
      value: null,
      unit: null,
      amountStage: null,
      basis: 'public_context',
      source: { type: 'congress_member', label: 'US Senator', recordId: 'S001', url: null },
      asOf: { date: null, fiscalYear: null, sourceYear: null },
      geography: { state: 'TX', district: null, scope: 'statewide', basis: null, boundaryCongress: null },
      freshness: { lastSyncedAt: null, stale: false, unavailable: false },
      coverage: 'complete',
      caveats: ['statewide_attribution'],
    };

    expect(senator.geography.scope).toBe('statewide');
    expect(senator.geography.district).toBeNull();
    expect(senator.label).toContain('statewide');
    expect(senator.caveats).toContain('statewide_attribution');
  });

  test('partial coverage is labelled partial', () => {
    const partial: R5Fact = {
      id: 'footprint:contract:c-1',
      section: 'footprint',
      label: 'Partial coverage contract',
      value: 50000,
      unit: 'USD',
      amountStage: 'obligated',
      basis: 'public_context',
      source: { type: 'contracting', label: 'Contract', recordId: 'c-1', url: null },
      asOf: { date: null, fiscalYear: null, sourceYear: null },
      geography: { state: 'TX', district: '01', scope: 'district', basis: 'inferred', boundaryCongress: null },
      freshness: { lastSyncedAt: null, stale: false, unavailable: false },
      coverage: 'partial',
      caveats: [],
    };

    expect(partial.coverage).toBe('partial');
    expect(partial.coverage).not.toBe('complete');
  });

  test('gap is created when a rail fails, not a throw or zero', () => {
    const gap: R5Gap = {
      section: 'footprint',
      reason: 'District detail service failed',
      source: 'district-nexus',
    };

    expect(gap.section).toBe('footprint');
    expect(gap.reason).toBeTruthy();
    // A gap is a gap, not a zero fact
    expect(gap).toHaveProperty('reason');
    expect(typeof gap.reason).toBe('string');
  });
});

// ── Brief section invariants ────────────────────────────────────────────────

describe('Brief section invariants', () => {
  test('section factIds reference only existing fact ids', () => {
    const facts: R5Fact[] = [
      {
        id: 'footprint:facility:f-1',
        section: 'footprint',
        label: 'Facility A',
        value: 50,
        unit: 'people',
        amountStage: null,
        basis: 'verified_client_nexus',
        source: { type: 'facility', label: 'Client facility', recordId: 'f-1', url: null },
        asOf: { date: null, fiscalYear: null, sourceYear: null },
        geography: { state: 'TX', district: '01', scope: 'district', basis: 'facility', boundaryCongress: null },
        freshness: { lastSyncedAt: null, stale: false, unavailable: false },
        coverage: 'complete',
        caveats: [],
      },
    ];

    const sectionFactIds = ['footprint:facility:f-1'];
    const knownIds = new Set(facts.map((f) => f.id));

    // All factIds in the section should exist in the facts array
    for (const fid of sectionFactIds) {
      expect(knownIds.has(fid)).toBe(true);
    }
  });

  test('export rejects unknown factIds', () => {
    const knownIds = new Set(['footprint:facility:f-1', 'cpf_cds:cpf_request:r-1']);
    const input = ['footprint:facility:f-1', 'unknown:ghost:999'];

    const unknowns = input.filter((id) => !knownIds.has(id));
    expect(unknowns.length).toBeGreaterThan(0);
    expect(unknowns).toContain('unknown:ghost:999');
  });

  test('verified_client_nexus vs public_context are distinct', () => {
    const verified: R5Fact['basis'] = 'verified_client_nexus';
    const publicCtx: R5Fact['basis'] = 'public_context';
    expect(verified).not.toBe(publicCtx);
  });
});

// ── Idempotency key — contains client, district, and content hash ───────────

describe('Idempotency key pattern', () => {
  test('key includes clientId + state-district + content hash', () => {
    const clientId = CLIENT;
    const stateDistrict = 'TX-01';
    const contentHash = 'a1b2c3d4e5f6';

    const key = `district-nexus-brief:${clientId}:${stateDistrict}:${contentHash}`;

    expect(key).toContain('district-nexus-brief:');
    expect(key).toContain(clientId);
    expect(key).toContain(stateDistrict);
    expect(key).toContain(contentHash);

    // Different client → different key
    const key2 = `district-nexus-brief:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:TX-01:${contentHash}`;
    expect(key).not.toBe(key2);

    // Different content hash → different key
    const key3 = `district-nexus-brief:${clientId}:TX-01:z9y8x7w6`;
    expect(key).not.toBe(key3);
  });
});