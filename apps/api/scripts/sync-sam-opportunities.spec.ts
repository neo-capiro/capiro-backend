import { describe, expect, test } from '@jest/globals';
import {
  buildSamSearchParams,
  defaultLookbackDaysForScope,
  parseSamSyncArgs,
  recordInSamScope,
  syncSourceForScope,
} from './sync-sam-opportunities.js';

describe('SAM opportunity ingestion scope', () => {
  test('defaults to the existing DoD scope for backward compatibility', () => {
    expect(parseSamSyncArgs(['--commit'])).toEqual({
      scope: 'dod',
      commit: true,
      backfill: false,
      matchOnly: false,
      since: null,
      postedTo: null,
    });
    expect(syncSourceForScope('dod')).toBe('sync-sam-opportunities');
    expect(defaultLookbackDaysForScope('dod')).toBe(30);
  });

  test('all-federal scope uses an independent watermark and short cold-start window', () => {
    expect(
      parseSamSyncArgs([
        '--all-federal',
        '--backfill',
        '--since=2026-07-01',
        '--posted-to',
        '2026-07-07',
      ]),
    ).toEqual({
      scope: 'all_federal',
      commit: false,
      backfill: true,
      matchOnly: false,
      since: '2026-07-01',
      postedTo: '2026-07-07',
    });
    expect(syncSourceForScope('all_federal')).toBe('sync-sam-opportunities-all-federal');
    expect(defaultLookbackDaysForScope('all_federal')).toBe(2);
  });

  test('DoD search sends the department filter, all-federal does not', () => {
    const common = {
      apiKey: 'test-key',
      postedFrom: '07/01/2026',
      postedTo: '07/02/2026',
      offset: 0,
    };
    expect(buildSamSearchParams({ ...common, scope: 'dod' }).get('deptname')).toBe(
      'DEPARTMENT OF DEFENSE',
    );
    expect(buildSamSearchParams({ ...common, scope: 'all_federal' }).has('deptname')).toBe(false);
  });

  test('client-side scope guard retains only DoD records in DoD mode', () => {
    const dod = { fullParentPathName: 'DEPT OF DEFENSE.DEPT OF THE ARMY.ACC' };
    const hhs = { fullParentPathName: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES.CDC' };
    expect(recordInSamScope(dod, 'dod')).toBe(true);
    expect(recordInSamScope(hhs, 'dod')).toBe(false);
    expect(recordInSamScope(dod, 'all_federal')).toBe(true);
    expect(recordInSamScope(hhs, 'all_federal')).toBe(true);
  });
});
