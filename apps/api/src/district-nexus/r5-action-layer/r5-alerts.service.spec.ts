import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import {
  R5DistrictAlertsService,
  type DistrictAlertEvent,
  type DistrictAlertPayload,
} from './r5-alerts.service.js';
import { stateAbbrForFips } from '../../common/us-states.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

// ── Mock utilities ────────────────────────────────────────────────────────────

function prismaWithTenantMock() {
  const tenantTx: Record<string, unknown> = {};
  const withTenant = jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(tenantTx),
  );
  const withSystem = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));

  const service = {
    withTenant,
    withSystem,
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  } as unknown as PrismaService;

  // Return an object that exposes tenantTx for mocking
  return {
    withTenant,
    withSystem,
    tenantTx,
    service,
  };
}

function configMock(baseUrl: string = 'https://os.capiro.ai') {
  return { get: (key: string) => (key === 'APP_BASE_URL' ? baseUrl : undefined) } as unknown;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('R5DistrictAlertsService', () => {
  describe('buildPayload', () => {
    it('normalizes numeric FIPS state code "12" to "FL" in deep link', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock() as any,
      );
      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-key-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: '12', // FIPS code
        districtCode: '8',
        severity: 'material',
        isStatewide: false,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test title',
        districtLabel: '12-8',
        sourceFreshness: 'fresh',
      };
      const payload = service.buildPayload(event, 'client-1');

      expect(payload.deepLink).toContain('district=FL-08');
      expect(payload.districtLabel).toBe('FL-08');
    });

    it('normalizes bare district "8" to "08"', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock() as any,
      );
      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-key-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: 'FL',
        districtCode: '8', // bare numeric district
        severity: 'material',
        isStatewide: false,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test title',
        districtLabel: 'FL-8',
        sourceFreshness: 'fresh',
      };
      const payload = service.buildPayload(event, 'client-1');

      expect(payload.deepLink).toContain('district=FL-08');
      expect(payload.districtLabel).toBe('FL-08');
    });

    it('preserves already-canonical "FL" and "08"', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock() as any,
      );
      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-key-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: 'FL', // already canonical
        districtCode: '08', // already zero-padded
        severity: 'material',
        isStatewide: false,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test title',
        districtLabel: 'FL-08',
        sourceFreshness: 'fresh',
      };
      const payload = service.buildPayload(event, 'client-1');

      expect(payload.deepLink).toContain('district=FL-08');
      expect(payload.districtLabel).toBe('FL-08');
    });

    it('produces correct deep link format with normalized state/district', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock('https://os.capiro.ai') as any,
      );
      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-key-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: 'TX',
        districtCode: '23',
        severity: 'material',
        isStatewide: false,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test title',
        districtLabel: 'TX-23',
        sourceFreshness: 'fresh',
      };
      const payload = service.buildPayload(event, 'client-abc');

      expect(payload.deepLink).toBe(
        'https://os.capiro.ai/intelligence/district-nexus?district=TX-23&clientId=client-abc',
      );
    });

    it('handles statewide event (districtCode = "00")', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock() as any,
      );
      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-key-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: 'CA',
        districtCode: '00',
        severity: 'material',
        isStatewide: true,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test title',
        districtLabel: 'CA (statewide)',
        sourceFreshness: 'fresh',
      };
      const payload = service.buildPayload(event, 'client-1');

      expect(payload.deepLink).toContain('district=CA-00');
      expect(payload.districtLabel).toBe('CA (statewide)');
    });
  });

  describe('listClientAlerts', () => {
    test('query uses text type comparison for user_id (not UUID)', () => {
      const { service, capturedSql, capturedValues } = createServiceWithCapturedQuery();

      const tenantId = 'tenant-1';
      const clientId = 'client-1';
      const userId = 'user@example.com'; // non-UUID string

      service.listClientAlerts(tenantId, clientId, 'FL', '08', userId);

      const sql = capturedSql();
      const values = capturedValues();
      expect(sql).toBeDefined();
      // 10 parameters: tenantId x2, clientId x2, userId x2, state x2, district x2 (each used twice)
      expect(values).toHaveLength(10);

      // The fix: userId is cast as text, not uuid
      // Check that the SQL template uses ?::text for user_id comparisons
      expect(sql).toContain('n.user_id = ?::text');
      // The SQL uses placeholder syntax (?), not literal values, so we check the template
    });

    test('userId undefined produces NULL text comparison that does not filter', () => {
      const { service, capturedSql, capturedValues } = createServiceWithCapturedQuery();

      const tenantId = 'tenant-1';
      const clientId = 'client-1';

      service.listClientAlerts(tenantId, clientId);

      const sql = capturedSql();
      const values = capturedValues();
      expect(sql).toBeDefined();
      // When userId, state, district are undefined, they all become NULL
      // 10 parameters: tenantId x2, clientId x2, userId x2, state x2, district x2
      expect(values).toHaveLength(10);

      // NULL::text IS NULL means the condition evaluates to true for all rows
      // For undefined inputs, the SQL uses (?)::text IS NULL pattern
      expect(sql).toContain('?::text IS NULL OR n.user_id = ?::text');
    });
  });

  describe('deepLink', () => {
    test('produces correct format with normalized state/district', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock('https://os.capiro.ai') as any,
      );

      const link = service.deepLink('FL', '8', 'client-123');
      expect(link).toBe(
        'https://os.capiro.ai/intelligence/district-nexus?district=FL-08&clientId=client-123',
      );
    });

    test('preserves already-zero-padded district', () => {
      const service = new R5DistrictAlertsService(
        prismaWithTenantMock().service,
        configMock('https://os.capiro.ai') as any,
      );

      const link = service.deepLink('TX', '23', 'client-456');
      expect(link).toBe(
        'https://os.capiro.ai/intelligence/district-nexus?district=TX-23&clientId=client-456',
      );
    });
  });

  describe('alertId static method', () => {
    test('produces correct format', () => {
      const tenantId = '11111111-1111-1111-1111-111111111111';
      const clientId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const dedupeKey = 'change-12345';

      const result = R5DistrictAlertsService.alertId(tenantId, clientId, dedupeKey);

      expect(result).toBe(`district-nexus-change:${tenantId}:${clientId}:${dedupeKey}`);
    });
  });

  describe('findRelevantClients', () => {
    test('converts FIPS state code to abbreviation before facility matching', async () => {
      const mockPrisma = prismaWithTenantMock();
      const service = new R5DistrictAlertsService(mockPrisma.service, configMock() as any);

      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: '12', // FIPS code for FL
        districtCode: '8',
        severity: 'material',
        isStatewide: false,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test',
        districtLabel: '12-8',
        sourceFreshness: 'fresh',
      };

      const mockFacility = {
        clientId: 'client-abc',
        client: { name: 'Test Client' },
      };

      mockPrisma.tenantTx.clientFacility = {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          // Verify where clause contains normalized state 'FL', not raw '12'
          expect(where.state).toBe('FL');
          expect(where.congressionalDistrict).toBe('08');
          return [mockFacility];
        }),
      } as any;

      const result = await service.findRelevantClients('tenant-1', event);

      expect(result).toEqual([{ clientId: 'client-abc', clientName: 'Test Client' }]);
    });

    test('handles null/empty district for statewide events', async () => {
      const mockPrisma = prismaWithTenantMock();
      const service = new R5DistrictAlertsService(mockPrisma.service, configMock() as any);

      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: '12', // FIPS for FL
        districtCode: '00',
        severity: 'material',
        isStatewide: true,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test',
        districtLabel: '12 (statewide)',
        sourceFreshness: 'fresh',
      };

      mockPrisma.tenantTx.clientFacility = {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          // isStatewide → district filter is { not: null } (any district)
          expect(where.congressionalDistrict).not.toBeUndefined();
          return [];
        }),
      } as any;

      const result = await service.findRelevantClients('tenant-1', event);
      expect(result).toEqual([]);
    });

    test('returns empty array when FIPS state code cannot be resolved', async () => {
      const mockPrisma = prismaWithTenantMock();
      const service = new R5DistrictAlertsService(mockPrisma.service, configMock() as any);

      const event: DistrictAlertEvent = {
        changeId: 'change-1',
        dedupeKey: 'dedupe-1',
        changeKind: 'funding_change',
        source: 'cpf_cds',
        sourceLabel: 'CPF/CDS',
        sourceRecordId: 'src-1',
        stateCode: '99', // Invalid FIPS
        districtCode: '8',
        severity: 'material',
        isStatewide: false,
        oldState: null,
        newState: null,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        detectedAt: new Date('2026-01-01T12:00:00Z'),
        sourceYear: 2026,
        observationKind: 'change',
        title: 'Test',
        districtLabel: '99-8',
        sourceFreshness: 'fresh',
      };

      const result = await service.findRelevantClients('tenant-1', event);
      expect(result).toEqual([]);
    });
  });
});

// ── Helper: service with captured raw SQL ─────────────────────────────────────

function createServiceWithCapturedQuery() {
  const mockPrisma = prismaWithTenantMock();
  const service = new R5DistrictAlertsService(mockPrisma.service, configMock() as any);

  let capturedSql: string | null = null;
  let capturedValues: unknown[] = [];
  mockPrisma.tenantTx.$queryRaw = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedSql = Array.isArray(strings) ? strings.join('?') : String(strings);
      capturedValues = values;
      return [];
    },
  );

  return {
    service,
    capturedSql: () => capturedSql,
    capturedValues: () => capturedValues,
  };
}
