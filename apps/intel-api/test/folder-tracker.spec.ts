import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  FeatureFlagService,
  FOLDER_TRACKER_FEATURE,
  BILL_360_FEATURE,
} from '../src/feature-flags/feature-flag.service.js';
import {
  canEditFolder,
  csvCell,
  normalizeBillNumber,
} from '../src/tracker/folders/folder-tracker.service.js';
import {
  FolderContextDto,
  FolderBoardQueryDto,
} from '../src/tracker/folders/folder-tracker.dto.js';

describe('folder tracker contracts', () => {
  it('requires explicit opt-in internally while preserving existing canary defaults', async () => {
    const tx = {
      featureFlag: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const flags = new FeatureFlagService(
      { withTenant: async (_: string, fn: (t: typeof tx) => unknown) => fn(tx) } as never,
      { get: () => 'internal' } as never,
    );
    expect(await flags.isEnabled(FOLDER_TRACKER_FEATURE, 'internal')).toBe(false);
    expect((await flags.enabledFor('internal'))[FOLDER_TRACKER_FEATURE]).toBeUndefined();
    expect(await flags.isEnabled(BILL_360_FEATURE, 'internal')).toBe(true);
    tx.featureFlag.findUnique.mockResolvedValue({ enabled: true });
    expect(await flags.isEnabled(FOLDER_TRACKER_FEATURE, 'internal')).toBe(true);
    tx.featureFlag.findUnique.mockResolvedValue({ enabled: false });
    expect(await flags.isEnabled(FOLDER_TRACKER_FEATURE, 'internal')).toBe(false);
  });
  it('lets the mapped owner edit a read-only folder, rejects others and unresolved ownership', () => {
    expect(canEditFolder({ ownerClerkId: 'owner', otherUserAccess: 'read_only' }, 'owner')).toBe(
      true,
    );
    expect(canEditFolder({ ownerClerkId: 'owner', otherUserAccess: 'read_only' }, 'other')).toBe(
      false,
    );
    expect(canEditFolder({ ownerClerkId: null, otherUserAccess: 'read_change' }, 'admin')).toBe(
      false,
    );
  });
  it('keeps proposal types distinct and normalizes padded bill numbers', () => {
    expect(normalizeBillNumber('S.B. 0482')).toBe('SB482');
    expect(normalizeBillNumber('HCB1')).toBe('HCB1');
    expect(normalizeBillNumber('HB1')).not.toBe(normalizeBillNumber('HCB1'));
    expect(normalizeBillNumber('arbitrary words')).toBeNull();
    expect(normalizeBillNumber('H0027', 'FL')).toBe('HB27');
    expect(normalizeBillNumber('S0028', 'FL')).toBe('SB28');
    expect(normalizeBillNumber('H0027', 'GA')).toBe('H27');
    for (const proposal of ['HCB27', 'SAB28', 'GOS27', 'BUC27', 'WMC27'])
      expect(normalizeBillNumber(proposal, 'FL')).toBe(proposal);
  });
  it('escapes formulas, quote and multiline text without flattening comments', () => {
    for (const prefix of ['=', '+', '-', '@', '  =', '\t='])
      expect(csvCell(prefix + 'SUM(A1)')).toContain("'");
    expect(csvCell('Line one\n"Line two"')).toBe('"Line one\n""Line two"""');
  });
  it('accepts priority, high importance and oppose simultaneously', async () => {
    const input = plainToInstance(FolderContextDto, {
      expectedVersion: 2,
      topPriority: true,
      importance: 'high',
      position: 'oppose',
      internalComments: 'Private',
      externalComments: 'Public-facing analysis',
    });
    expect(await validate(input, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
  it('rejects incomplete scope and injected ownership fields', async () => {
    expect(
      (await validate(plainToInstance(FolderBoardQueryDto, { jurisdiction: 'FL' }))).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(FolderContextDto, {
            expectedVersion: 0,
            topPriority: false,
            importance: 'normal',
            position: 'none',
            internalComments: '',
            externalComments: '',
            tenantId: 'foreign',
          }),
          { whitelist: true, forbidNonWhitelisted: true },
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
