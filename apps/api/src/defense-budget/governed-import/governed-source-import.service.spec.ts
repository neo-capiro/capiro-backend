import {
  armyRdteOfficialUrl,
  armyRdteTitle,
  ARMY_RDTE_VOLUME_CATALOG,
} from '@capiro/defense-domain';
import { GovernedSourceImportService } from './governed-source-import.service.js';
import type { GovernedSourceImportStore } from './governed-source-import.store.js';

const FY = 2024;
const VOL1_BA1 = ARMY_RDTE_VOLUME_CATALOG.find((e) => e.memberKey === 'volume_1_ba_1')!;
const OFFICIAL_URL = armyRdteOfficialUrl(VOL1_BA1, FY);
const TITLE = armyRdteTitle(VOL1_BA1, FY);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('x'.repeat(64))]);

function makeStoreSpy(): GovernedSourceImportStore {
  return {
    loadContext: jest.fn().mockResolvedValue({
      expectedSource: {
        id: 'expected-source-1',
        dedupKey: 'a'.repeat(64),
        cycleId: 'cycle-1',
        fiscalYear: FY,
        authorityTrack: 'request',
        stage: 'president_budget_request',
        sourceFamily: 'pb_r2',
        component: 'ARMY',
        adapterId: 'army-budget',
      },
      bundleMember: {
        id: 'member-1',
        expectedSourceId: 'expected-source-1',
        memberKey: VOL1_BA1.memberKey,
        officialUrl: OFFICIAL_URL,
        title: TITLE,
        required: true,
        memberStatus: 'missing',
        boundContentSha256: null,
      },
      siblingMembers: [],
    }),
    recordGovernedObservation: jest.fn(),
    enqueueGovernedIngestion: jest.fn(),
    markMemberBound: jest.fn(),
    recordAudit: jest.fn(),
    loadSourceDocumentArchiveLocator: jest.fn(),
  } as unknown as GovernedSourceImportStore;
}

describe('GovernedSourceImportService — Phase 10B-18 Part F/K/M', () => {
  it('dry run (no --commit): validates and previews, but performs ZERO store mutation', async () => {
    const store = makeStoreSpy();
    const service = new GovernedSourceImportService(store, {} as never, {
      rawArchiveBucket: 'unused-in-dry-run',
      rawArchiveKmsKeyArn: undefined,
      retentionYears: 7,
      parserArtifactRoot: '/unused',
      s3: {} as never,
      s3Commands: {} as never,
    });

    const result = await service.run({
      expectedSourceId: 'expected-source-1',
      memberId: 'member-1',
      officialUrl: OFFICIAL_URL,
      fileBytes: PDF_BYTES,
      actor: 'neo@capiro.ai',
      reason: 'dry run before any authorized commit',
      commit: false,
      nowIso: '2026-08-30T00:00:00.000Z',
    });

    expect('mode' in result && result.mode).toBe('dry_run');
    expect(store.recordGovernedObservation).not.toHaveBeenCalled();
    expect(store.enqueueGovernedIngestion).not.toHaveBeenCalled();
    expect(store.markMemberBound).not.toHaveBeenCalled();
    expect(store.recordAudit).not.toHaveBeenCalled();
  });

  it('dry run reports a validation refusal without ever reaching a mutation call', async () => {
    const store = makeStoreSpy();
    const service = new GovernedSourceImportService(store, {} as never, {
      rawArchiveBucket: 'unused',
      rawArchiveKmsKeyArn: undefined,
      retentionYears: 7,
      parserArtifactRoot: '/unused',
      s3: {} as never,
      s3Commands: {} as never,
    });

    const result = await service.run({
      expectedSourceId: 'expected-source-1',
      memberId: 'member-1',
      officialUrl: OFFICIAL_URL,
      fileBytes: Buffer.alloc(0), // empty file -> refused
      actor: 'neo@capiro.ai',
      reason: 'dry run',
      commit: false,
      nowIso: '2026-08-30T00:00:00.000Z',
    });

    expect('accepted' in result && result.accepted).toBe(false);
    expect(store.recordGovernedObservation).not.toHaveBeenCalled();
  });

  it('a validation refusal at commit time also performs ZERO mutation', async () => {
    const store = makeStoreSpy();
    const service = new GovernedSourceImportService(store, {} as never, {
      rawArchiveBucket: 'unused',
      rawArchiveKmsKeyArn: undefined,
      retentionYears: 7,
      parserArtifactRoot: '/unused',
      s3: {} as never,
      s3Commands: {} as never,
    });

    const result = await service.run({
      expectedSourceId: 'expected-source-1',
      memberId: 'member-1',
      officialUrl: OFFICIAL_URL,
      fileBytes: Buffer.alloc(0),
      actor: 'neo@capiro.ai',
      reason: 'commit attempt with bad file',
      commit: true,
      nowIso: '2026-08-30T00:00:00.000Z',
    });

    expect('accepted' in result && result.accepted).toBe(false);
    expect(store.recordGovernedObservation).not.toHaveBeenCalled();
    expect(store.markMemberBound).not.toHaveBeenCalled();
    expect(store.recordAudit).not.toHaveBeenCalled();
  });

  it('an unknown expected source id fails closed before any validation or mutation', async () => {
    const store = makeStoreSpy();
    (store.loadContext as jest.Mock).mockResolvedValue({ error: 'expected source does not exist' });
    const service = new GovernedSourceImportService(store, {} as never, {
      rawArchiveBucket: 'unused',
      rawArchiveKmsKeyArn: undefined,
      retentionYears: 7,
      parserArtifactRoot: '/unused',
      s3: {} as never,
      s3Commands: {} as never,
    });

    const result = await service.run({
      expectedSourceId: 'does-not-exist',
      memberId: 'member-1',
      officialUrl: OFFICIAL_URL,
      fileBytes: PDF_BYTES,
      actor: 'neo@capiro.ai',
      reason: 'wrong id',
      commit: true,
      nowIso: '2026-08-30T00:00:00.000Z',
    });

    expect('error' in result).toBe(true);
    expect(store.recordGovernedObservation).not.toHaveBeenCalled();
  });
});
