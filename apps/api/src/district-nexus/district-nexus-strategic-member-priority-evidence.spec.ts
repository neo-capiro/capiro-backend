/**
 * Regression coverage for a defect found via independent review of the
 * priority-intelligence hotfix: `loadMemberPriorityEvidence` ran the exact
 * same class of bug being fixed elsewhere in this PR — it selected the
 * non-existent `congress_member.state_code` column (real column: `state`)
 * and read the INTEGER `district` column as if it were already text (no
 * `::text` cast), so `member.district?.trim()` would throw on a real row
 * even if the column reference didn't fail first.
 *
 * Unlike the priority-intelligence endpoint, this method already wraps its
 * body in a try/catch that degrades to `strength: 'unavailable'` on any
 * error — so this defect never 500'd anything. It silently made the
 * Strategic Relevance "member historical priorities" evidence component
 * permanently unavailable instead, which is a real live degradation just a
 * quieter one.
 */
import { describe, expect, jest, test } from '@jest/globals';
import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import type { DistrictNexusService } from './district-nexus.service.js';

function sqlTextOf(strings: TemplateStringsArray): string {
  return Array.isArray(strings) ? strings.join('?') : String(strings);
}

function makeService(opts: {
  memberRows: Array<{
    bioguide_id: string;
    chamber: string;
    state_code: string | null;
    district: string | null;
  }>;
  requestRows?: Array<Record<string, unknown>>;
}) {
  const capturedSql: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = sqlTextOf(strings);
      capturedSql.push(sql);
      return opts.memberRows;
    }),
    communityFundingRequest: {
      findFirst: jest.fn<() => Promise<{ id: string } | null>>(async () => ({ id: 'seed' })),
      findMany: jest.fn<() => Promise<Array<Record<string, unknown>>>>(
        async () => opts.requestRows ?? [],
      ),
    },
  } as unknown as PrismaService;
  const svc = new DistrictNexusStrategicService(
    prisma,
    {} as ClientPeRelevanceService,
    {} as DistrictNexusService,
  );
  const loadMemberPriorityEvidence = (
    svc as unknown as {
      loadMemberPriorityEvidence: (
        bioguides: ReadonlySet<string>,
        stateCode: string,
        districtKey: string,
      ) => Promise<{ strength: string; evidenceCount: number; rationale: string }>;
    }
  ).loadMemberPriorityEvidence.bind(svc);
  return { loadMemberPriorityEvidence, capturedSql };
}

describe('DistrictNexusStrategicService — loadMemberPriorityEvidence congress_member query', () => {
  test('queries congress_member.state (not the non-existent state_code) and casts district to text', async () => {
    const { loadMemberPriorityEvidence, capturedSql } = makeService({
      memberRows: [{ bioguide_id: 'M001234', chamber: 'house', state_code: 'FL', district: '08' }],
    });

    await loadMemberPriorityEvidence(new Set(['M001234']), 'FL', 'FL-08');

    const memberSql = capturedSql.find((sql) => sql.includes('congress_member'));
    expect(memberSql).toBeDefined();
    expect(memberSql).toMatch(/\bstate\b\s+AS\s+state_code/i);
    expect(memberSql).not.toMatch(/FROM congress_member[\s\S]*?\bstate_code\b(?!\s+AS)/i);
    expect(memberSql).toMatch(/district::text AS district/i);
  });

  test('a house member with a real district does not throw when computing at-large/sentinel handling', async () => {
    // Before the fix, `district` came back as a raw INTEGER from the pg
    // driver (no ::text cast), and member.district?.trim() would throw
    // "d.trim is not a function" on any real row reaching this line.
    const { loadMemberPriorityEvidence } = makeService({
      memberRows: [{ bioguide_id: 'M001234', chamber: 'house', state_code: 'FL', district: '08' }],
      requestRows: [],
    });

    await expect(loadMemberPriorityEvidence(new Set(['M001234']), 'FL', 'FL-08')).resolves.toEqual(
      expect.objectContaining({ strength: expect.any(String) }),
    );
  });

  test('a query failure still degrades to unavailable, never throws out of this method', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => {
        throw new Error('column cm.state_code does not exist');
      }),
      communityFundingRequest: {
        findFirst: jest.fn<() => Promise<{ id: string } | null>>(async () => ({ id: 'seed' })),
        findMany: jest.fn<() => Promise<Array<Record<string, unknown>>>>(async () => []),
      },
    } as unknown as PrismaService;
    const svc = new DistrictNexusStrategicService(
      prisma,
      {} as ClientPeRelevanceService,
      {} as DistrictNexusService,
    );
    const loadMemberPriorityEvidence = (
      svc as unknown as {
        loadMemberPriorityEvidence: (
          bioguides: ReadonlySet<string>,
          stateCode: string,
          districtKey: string,
        ) => Promise<{ strength: string; evidenceCount: number; rationale: string }>;
      }
    ).loadMemberPriorityEvidence.bind(svc);

    const result = await loadMemberPriorityEvidence(new Set(['M001234']), 'FL', 'FL-08');
    expect(result.strength).toBe('unavailable');
    expect(result.evidenceCount).toBe(0);
  });
});
