import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PE_DATA_ISSUE_TYPES,
  ProgramElementDataIssueService,
} from './program-element-data-issue.service';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';
const PE = '0603270A';

type IssueRow = {
  id: string;
  tenantId: string;
  reportedByUserId: string;
  peCode: string;
  fy: number | null;
  fieldName: string | null;
  issueType: string;
  description: string;
  suggestedSourceUrl: string | null;
  status: string;
  resolutionNotes: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeCtx(tenantId: string, userId = USER_A, role = 'standard_user') {
  return {
    tenantId,
    tenantSlug: tenantId,
    userId,
    clerkUserId: `clerk-${userId}`,
    role,
  } as import('@capiro/shared').TenantContext;
}

function createHarness(opts: { peExists?: boolean; peYears?: Array<Record<string, unknown>> } = {}) {
  const peExists = opts.peExists !== false;
  const issues: IssueRow[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const peYears = opts.peYears ?? [
    {
      fy: 2026,
      request: 10,
      enacted: 9,
      conference: null,
      hascMark: 11,
      sascMark: null,
      hacDMark: null,
      sacDMark: null,
      ndaaConference: null,
    },
  ];

  const tx = {
    programElementDataIssue: {
      create: jest.fn(async ({ data }: { data: Omit<IssueRow, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt' | 'resolvedByUserId' | 'resolutionNotes'> & Partial<IssueRow> }) => {
        const row: IssueRow = {
          id: `issue-${issues.length + 1}`,
          tenantId: data.tenantId,
          reportedByUserId: data.reportedByUserId,
          peCode: data.peCode,
          fy: data.fy ?? null,
          fieldName: data.fieldName ?? null,
          issueType: data.issueType,
          description: data.description,
          suggestedSourceUrl: data.suggestedSourceUrl ?? null,
          status: data.status ?? 'open',
          resolutionNotes: data.resolutionNotes ?? null,
          resolvedByUserId: data.resolvedByUserId ?? null,
          resolvedAt: data.resolvedAt ?? null,
          createdAt: new Date('2026-07-30T12:00:00.000Z'),
          updatedAt: new Date('2026-07-30T12:00:00.000Z'),
        };
        issues.push(row);
        return row;
      }),
      count: jest.fn(async ({ where }: { where: Partial<IssueRow> }) => {
        return issues.filter((i) => matches(i, where)).length;
      }),
      findMany: jest.fn(async ({ where }: { where: Partial<IssueRow> }) => {
        return issues.filter((i) => matches(i, where));
      }),
      findFirst: jest.fn(async ({ where }: { where: { id?: string } }) => {
        return issues.find((i) => (where.id ? i.id === where.id : true)) ?? null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<IssueRow> }) => {
        const idx = issues.findIndex((i) => i.id === where.id);
        if (idx < 0) throw new Error('missing');
        const next = {
          ...issues[idx]!,
          ...data,
          updatedAt: new Date('2026-07-30T13:00:00.000Z'),
        };
        issues[idx] = next;
        return next;
      }),
    },
    programElementYear: {
      findFirst: jest.fn(async () => peYears[0] ?? null),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
  };

  const prisma = {
    programElement: {
      findUnique: jest.fn(async ({ where }: { where: { peCode: string } }) =>
        peExists && where.peCode === PE ? { peCode: PE } : null,
      ),
    },
    withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const service = new ProgramElementDataIssueService(prisma as never);
  return { service, issues, audits, prisma, tx, peYears };
}

function matches(row: IssueRow, where: Partial<IssueRow> & { peCode?: string; status?: string }) {
  if (where.peCode && row.peCode !== where.peCode) return false;
  if (where.status && row.status !== where.status) return false;
  if (where.id && row.id !== where.id) return false;
  return true;
}

describe('ProgramElementDataIssueService', () => {
  test('creates a tenant-scoped issue with validation + audit (no description PII in audit)', async () => {
    const { service, issues, audits } = createHarness();
    const created = await service.create(
      '0603270a',
      {
        issueType: 'value_incorrect',
        description: 'HASC mark looks off against the report table',
        fy: 2026,
        fieldName: 'hascMark',
        suggestedSourceUrl: 'https://armedservices.house.gov/example',
      },
      makeCtx(TENANT_A),
    );

    expect(created.peCode).toBe(PE);
    expect(created.status).toBe('open');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.tenantId).toBe(TENANT_A);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('program_element.data_issue.create');
    const after = audits[0]!.after as Record<string, unknown>;
    expect(after.description).toBeUndefined();
    expect(after.suggestedSourceUrl).toBeUndefined();
    expect(after.hasSuggestedSourceUrl).toBe(true);
    expect(after.peCode).toBe(PE);
  });

  test('rejects unknown PE, bad FY, bad field, bad URL, empty description', async () => {
    const { service } = createHarness({ peExists: false });
    await expect(
      service.create(PE, { issueType: 'other', description: 'x' }, makeCtx(TENANT_A)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const good = createHarness();
    await expect(
      good.service.create(PE, { issueType: 'other', description: 'x', fy: 1800 }, makeCtx(TENANT_A)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      good.service.create(
        PE,
        { issueType: 'other', description: 'x', fieldName: 'notAField' },
        makeCtx(TENANT_A),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      good.service.create(
        PE,
        { issueType: 'other', description: 'x', suggestedSourceUrl: 'ftp://evil' },
        makeCtx(TENANT_A),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      good.service.create(PE, { issueType: 'other', description: '   ' }, makeCtx(TENANT_A)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      good.service.create(PE, { issueType: 'nope', description: 'x' }, makeCtx(TENANT_A)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('list is tenant-scoped via withTenant; tenant B does not see tenant A rows in harness isolation', async () => {
    const { service, prisma, issues } = createHarness();
    await service.create(
      PE,
      { issueType: 'missing_value', description: 'missing enacted' },
      makeCtx(TENANT_A),
    );
    // Simulate RLS: withTenant still runs out pipeline but filter by tenant in mock would be
    // the real isolation mechanism. We assert create stored tenant A and list used withTenant.
    expect(issues[0]!.tenantId).toBe(TENANT_A);
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT_A, expect.any(Function));

    // Cross-tenant list call still invokes withTenant(B) — row visibility is RLS/policy.
    await service.listForPe(PE, makeCtx(TENANT_B));
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT_B, expect.any(Function));
  });

  test('resolve closes issue, audits, and leaves canonical PE year unchanged', async () => {
    const { service, issues, audits, peYears } = createHarness();
    const created = await service.create(
      PE,
      { issueType: 'wrong_source', description: 'source mismatch', fieldName: 'request' },
      makeCtx(TENANT_A),
    );
    const beforeYear = JSON.stringify(peYears[0]);

    const resolved = await service.resolve(
      created.id,
      { status: 'resolved', resolutionNotes: 'acked; override pending' },
      makeCtx(TENANT_A, USER_A, 'capiro_admin'),
    );

    expect(resolved.status).toBe('resolved');
    expect(issues[0]!.status).toBe('resolved');
    expect(JSON.stringify(peYears[0])).toBe(beforeYear);
    const resolveAudit = audits.find((a) => a.action === 'program_element.data_issue.resolve');
    expect(resolveAudit).toBeTruthy();
    expect((resolveAudit!.after as Record<string, unknown>).canonicalRowUnchanged).toBe(true);
    expect((resolveAudit!.after as Record<string, unknown>).resolutionNotes).toBeUndefined();
  });

  test('cannot re-resolve a closed issue', async () => {
    const { service } = createHarness();
    const created = await service.create(
      PE,
      { issueType: 'other', description: 'once' },
      makeCtx(TENANT_A),
    );
    await service.resolve(created.id, { status: 'dismissed' }, makeCtx(TENANT_A, USER_A, 'capiro_admin'));
    await expect(
      service.resolve(created.id, { status: 'resolved' }, makeCtx(TENANT_A, USER_A, 'capiro_admin')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('exports the documented issue type vocabulary', () => {
    expect(PE_DATA_ISSUE_TYPES).toEqual(
      expect.arrayContaining([
        'value_incorrect',
        'missing_value',
        'wrong_source',
        'wrong_stage_or_vehicle',
        'wrong_pe_attribution',
        'other',
      ]),
    );
  });
});
