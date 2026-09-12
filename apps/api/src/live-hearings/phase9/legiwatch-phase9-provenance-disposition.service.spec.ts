import { ConflictException } from '@nestjs/common';
import 'reflect-metadata';
import {
  LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
  LegiWatchPhase9ProvenanceDispositionService,
  validateDetails,
} from './legiwatch-phase9-provenance-disposition.service.js';

type Row = Record<string, unknown>;

/**
 * SQL-behavior prisma stub: one dispatcher emulates every query the service
 * issues (outer + inside withSystem), so the refusal matrix and the happy
 * path run without a database.
 */
function prismaStub(rows: {
  hearingExists?: boolean;
  observations?: number;
  txObservations?: number;
  activeDispositions?: number;
  inserted?: Row;
  revoked?: Row;
}) {
  const state = {
    activeDispositions: rows.activeDispositions ?? 0,
    inserted: null as Row | null,
    revoked: null as Row | null,
  };
  const calls: string[] = [];
  const dispatch = async (sql: string): Promise<Row[]> => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push(s.slice(0, 60));
    if (s.includes('FROM federal_committee_hearing WHERE id=$1')) {
      return [{ n: rows.hearingExists ? 1 : 0 }];
    }
    if (
      s.includes('hearing_source_observation') &&
      s.includes("reconciliation_status='RECONCILED'")
    ) {
      // The withSystem re-check sees the post-validation state.
      const inTx = calls.filter((c) => c.startsWith('INSERT INTO canonical')).length > 0;
      return [
        { n: inTx ? (rows.txObservations ?? rows.observations ?? 0) : (rows.observations ?? 0) },
      ];
    }
    if (s.includes('FROM canonical_provenance_disposition') && s.includes("status='ACTIVE'")) {
      return [{ n: state.activeDispositions }];
    }
    if (s.includes('INSERT INTO canonical_provenance_disposition')) {
      state.inserted = rows.inserted ?? { id: 'disp-1' };
      return [state.inserted];
    }
    if (s.startsWith('UPDATE canonical_provenance_disposition')) {
      if (state.activeDispositions > 0) {
        state.activeDispositions -= 1;
        state.revoked = rows.revoked ?? { id: 'disp-1' };
        return [state.revoked];
      }
      return [];
    }
    throw new Error('unexpected query: ' + s.slice(0, 120));
  };
  const service = {
    $queryRawUnsafe: dispatch,
    $executeRawUnsafe: async () => 0,
    withSystem: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRawUnsafe: dispatch }),
  };
  return {
    prisma: service as unknown as import('../../prisma/prisma.service.js').PrismaService,
    state,
    calls,
  };
}

function validInput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    hearingId: 'cm-119-test',
    dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
    reasonCode: 'CLOSED_BRIEFING_NO_PUBLIC_EVENT_RECORD',
    artifactUri: 's3://bucket/investigation.json',
    details: { investigatedAt: '2026-09-02', sourcesProbed: 6 },
    reviewedBy: 'neo-authorized-operator',
    reviewedAt: new Date('2026-09-02T12:00:00Z'),
    confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    ...overrides,
  };
}

describe('LegiWatchPhase9ProvenanceDispositionService', () => {
  it('1. creates a reviewed valid disposition', async () => {
    const { prisma, state } = prismaStub({ hearingExists: true, observations: 0 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    const result = await service.apply(validInput() as never);
    expect(result).toMatchObject({ id: 'disp-1' });
    expect(state.inserted).not.toBeNull();
  });

  it('2. rejects an unsupported disposition type', async () => {
    const { prisma } = prismaStub({ hearingExists: true });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(
      service.apply(validInput({ dispositionType: 'WE_COULD_NOT_FIND_A_PAGE' }) as never),
    ).rejects.toThrow(/unsupported dispositionType/);
  });

  it('3. rejects a missing artifact URI', async () => {
    const { prisma } = prismaStub({ hearingExists: true });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(service.apply(validInput({ artifactUri: '' }) as never)).rejects.toThrow(
      /artifactUri is required/,
    );
  });

  it('3b. rejects a local filesystem artifact URI', async () => {
    const { prisma } = prismaStub({ hearingExists: true });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(
      service.apply(validInput({ artifactUri: 'file:///C:/secret.json' }) as never),
    ).rejects.toThrow(/credential-free/);
  });

  it('4. rejects a missing reviewer', async () => {
    const { prisma } = prismaStub({ hearingExists: true });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(service.apply(validInput({ reviewedBy: '  ' }) as never)).rejects.toThrow(
      /reviewedBy is required/,
    );
  });

  it('5. rejects a hearing that does not exist', async () => {
    const { prisma } = prismaStub({ hearingExists: false });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(service.apply(validInput() as never)).rejects.toThrow(/does not exist/);
  });

  it('6. rejects a hearing already backed by a reconciled observation (observation wins)', async () => {
    const { prisma } = prismaStub({ hearingExists: true, observations: 2 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(service.apply(validInput() as never)).rejects.toThrow(
      /observation provenance wins/,
    );
  });

  it('7. rejects a second conflicting ACTIVE disposition', async () => {
    const { prisma } = prismaStub({ hearingExists: true, activeDispositions: 1 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(service.apply(validInput() as never)).rejects.toThrow(
      /already has an ACTIVE provenance disposition/,
    );
  });

  it('8. requires the exact confirmation phrase for apply()', async () => {
    const { prisma } = prismaStub({ hearingExists: true });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(service.apply(validInput({ confirmation: 'please' }) as never)).rejects.toThrow(
      ConflictException,
    );
    await expect(
      service.apply(
        validInput({ confirmation: 'record reviewed legiwatch provenance disposition' }) as never,
      ),
    ).rejects.toThrow(/Exact confirmation required/);
  });

  it('8b. preview validates without confirmation and writes nothing', async () => {
    const { prisma, state } = prismaStub({
      hearingExists: true,
      observations: 0,
      activeDispositions: 0,
    });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    const result = await service.preview(validInput() as never);
    expect(result.wouldApply).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(state.inserted).toBeNull();
  });

  it('8c. preview surfaces every refusal at once', async () => {
    const { prisma } = prismaStub({ hearingExists: false, observations: 3, activeDispositions: 1 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    const result = await service.preview(
      validInput({
        dispositionType: 'BAD',
        reasonCode: 'WORSE',
        artifactUri: '',
      }) as never,
    );
    expect(result.wouldApply).toBe(false);
    expect(result.refusals).toEqual([
      expect.stringMatching(/unsupported dispositionType/),
      expect.stringMatching(/unsupported reasonCode/),
      expect.stringMatching(/artifactUri is required/),
      expect.stringMatching(/does not exist/),
      expect.stringMatching(/observation provenance wins/),
      expect.stringMatching(/already has an ACTIVE/),
    ]);
  });

  it('9. revoke marks the ACTIVE row REVOKED via the guarded UPDATE (history kept)', async () => {
    const { prisma, state } = prismaStub({ activeDispositions: 1 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    const result = await service.revoke({
      hearingId: 'cm-119-test',
      actor: 'operator-x',
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    expect(result).toMatchObject({ id: 'disp-1' });
    expect(state.revoked).not.toBeNull();
  });

  it('9b. revoke with no ACTIVE row is a NotFound', async () => {
    const { prisma } = prismaStub({ activeDispositions: 0 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(
      service.revoke({
        hearingId: 'cm-119-test',
        actor: 'op',
        confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
      }),
    ).rejects.toThrow(/no ACTIVE provenance disposition/);
  });

  it('9c. revoke without the confirmation phrase is refused', async () => {
    const { prisma } = prismaStub({ activeDispositions: 1 });
    const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);
    await expect(
      service.revoke({ hearingId: 'cm-119-test', actor: 'op', confirmation: 'nope' }),
    ).rejects.toThrow(/Exact confirmation required/);
  });

  it('10. rejects details containing tenant/customer/secret keys', () => {
    expect(validateDetails({ tenantId: '17b63099' })).toHaveLength(1);
    expect(validateDetails({ nested: { apiKey: 'x' } })).toHaveLength(1);
    expect(validateDetails({ list: [{ clientSecret: 'x' }] })).toHaveLength(1);
    expect(
      validateDetails({ sourcesProbed: 6, verdict: 'OFFICIAL_OBSERVATION_UNAVAILABLE' }),
    ).toEqual([]);
  });

  it('11. DI metadata: design:paramtypes is present (#1398 regression guard)', () => {
    const metadata = Reflect.getMetadata(
      'design:paramtypes',
      LegiWatchPhase9ProvenanceDispositionService,
    );
    expect(metadata).toBeDefined();
    expect(metadata.length).toBe(1);
  });
});
