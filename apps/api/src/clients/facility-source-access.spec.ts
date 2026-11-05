import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import {
  preserveFacilityImpactHistory,
  preserveUnavailableFacilityEvidence,
  visibleFacilitySources,
} from './facility-source-access.js';

const ctx = { tenantId: 'tenant', userId: 'user' } as TenantContext;

describe('facility source visibility', () => {
  test('preserves approved values and public evidence while removing withdrawn document excerpts', async () => {
    const query = jest.fn(async (_sql: string, id: unknown) =>
      id === 'visible' ? [{ id, prospectId: null }] : [],
    );
    const tx = { $queryRawUnsafe: query } as unknown as Prisma.TransactionClient;
    const publicSource = {
      sourceType: 'website',
      sourceUrl: 'https://example.com/site',
      evidence: 'Public quote',
    };
    const visibleDocument = {
      sourceType: 'document',
      attachmentId: 'visible',
      evidence: 'Shared quote',
    };
    const facility = {
      name: 'Approved facility',
      siteVerificationStatus: 'verified',
      sourceEvidence: [
        publicSource,
        visibleDocument,
        { sourceType: 'document', attachmentId: 'withdrawn', evidence: 'Private excerpt' },
      ],
      economicImpact: {
        employees: 150,
        evidence: [
          { metadata: { attachmentId: 'withdrawn' }, excerpt: 'Private employment detail' },
        ],
      },
      geographicHistory: [{ status: 'resolved', provider: 'census' }],
    };
    const result = await visibleFacilitySources(tx, ctx, 'client', facility);
    expect(result).toMatchObject({
      name: facility.name,
      siteVerificationStatus: 'verified',
      sourceEvidenceUnavailable: true,
      sourceEvidence: [publicSource, visibleDocument],
      economicImpact: { employees: 150, evidence: [], sourceUnavailable: true },
      geographicHistory: facility.geographicHistory,
    });
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(facility.sourceEvidence).toHaveLength(3);
    expect(
      query.mock.calls.every(
        ([sql]) =>
          sql.includes("a.viewer_mode='all'") &&
          sql.includes('a.superseded_by_attachment_id IS NULL'),
      ),
    ).toBe(true);
  });

  test('does not hide storage errors as source withdrawal', async () => {
    const error = new Error('Database unavailable');
    const tx = {
      $queryRawUnsafe: async () => {
        throw error;
      },
    } as unknown as Prisma.TransactionClient;
    await expect(
      visibleFacilitySources(tx, ctx, 'client', { sourceEvidence: [{ attachmentId: 'doc' }] }),
    ).rejects.toBe(error);
  });

  test('redacts documents when their owner is no longer visible', async () => {
    const tx = {
      $queryRawUnsafe: async () => {
        throw new NotFoundException('Source owner not available');
      },
    } as unknown as Prisma.TransactionClient;
    await expect(
      visibleFacilitySources(tx, ctx, 'client', {
        sourceEvidence: [{ attachmentId: 'doc', evidence: 'old excerpt' }],
      }),
    ).resolves.toEqual({ sourceEvidence: [], sourceEvidenceUnavailable: true });
  });

  test('adding a source after a redacted read preserves hidden history without restoring its visibility', async () => {
    const tx = { $queryRawUnsafe: async () => [] } as unknown as Prisma.TransactionClient;
    const hidden = {
      sourceType: 'document',
      attachmentId: 'withdrawn',
      evidence: 'Old private quote',
    };
    const replaced = { sourceType: 'website', sourceUrl: 'https://example.com/old' };
    const added = { sourceType: 'website', sourceUrl: 'https://example.com/new' };
    const saved = await preserveUnavailableFacilityEvidence(
      tx,
      ctx,
      'client',
      [hidden, replaced],
      [added, added],
    );
    expect(saved).toEqual([hidden, added]);
    await expect(
      visibleFacilitySources(tx, ctx, 'client', { sourceEvidence: saved }),
    ).resolves.toEqual({ sourceEvidence: [added], sourceEvidenceUnavailable: true });
  });

  test('an unchanged impact claim retains hidden source evidence when a visible citation is added', async () => {
    const tx = { $queryRawUnsafe: async () => [] } as unknown as Prisma.TransactionClient;
    const hidden = { attachmentId: 'withdrawn', excerpt: 'Private old employment evidence' };
    const added = { sourceUrl: 'https://example.com/jobs', excerpt: 'New public evidence' };
    const saved = await preserveFacilityImpactHistory(
      tx,
      ctx,
      'client',
      { employees: 100, evidence: [hidden] },
      { employees: 100, evidence: [added], sourceUnavailable: true },
    );
    expect(saved).toEqual({ employees: 100, evidence: [hidden, added] });
    const view = await visibleFacilitySources(tx, ctx, 'client', { economicImpact: saved });
    expect(view.economicImpact).toEqual({
      employees: 100,
      evidence: [added],
      sourceUnavailable: true,
    });
  });

  test('changed economics retain prior evidence only with prior values and redact historical excerpts', async () => {
    const tx = { $queryRawUnsafe: async () => [] } as unknown as Prisma.TransactionClient;
    const hidden = { attachmentId: 'withdrawn', excerpt: 'Private evidence for 100 employees' };
    const added = { sourceUrl: 'https://example.com/jobs', excerpt: '200 employees now' };
    const saved = await preserveFacilityImpactHistory(
      tx,
      ctx,
      'client',
      { employees: 100, evidence: [hidden] },
      { employees: 200, evidence: [added], history: [{ employees: 9999, evidence: [] }] },
    );
    expect(saved).toEqual({
      employees: 200,
      evidence: [added],
      history: [{ employees: 100, evidence: [hidden] }],
    });
    const view = await visibleFacilitySources(tx, ctx, 'client', { economicImpact: saved });
    expect(view.economicImpact).toEqual({
      employees: 200,
      evidence: [added],
      history: [{ employees: 100, evidence: [], sourceUnavailable: true }],
    });
    expect(JSON.stringify(view)).not.toContain('Private evidence');
  });
});
