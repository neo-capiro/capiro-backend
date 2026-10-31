import { mergeRecipients, normalizeEmail } from './recipients.service.js';
import { capturedRule } from './record-rule.service.js';
import { localOccurrence } from './delivery-schedule.js';

describe('recipients and captured rules', () => {
  it('preserves alias identities while deduplicating a normalized destination', () => {
    const base = {
      email: normalizeEmail('TEST@example.com'),
      role: 'bcc' as const,
      name: '',
      lists: [],
      manual: false,
    };
    const result = mergeRecipients([
      { ...base, contacts: [{ id: 'a', version: 0 }] },
      { ...base, contacts: [{ id: 'b', version: 0 }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.contacts).toHaveLength(2);
    expect(() => mergeRecipients([result[0]!, { ...result[0]!, role: 'to' }])).toThrow(
      'CONFLICTING_TO_BCC',
    );
  });
  it('uses captured cadence, keeps empty targets, and rejects other alert families', () => {
    expect(
      capturedRule({
        family: 'Bill Action and Amendments Filed Alert',
        name: 'Daily example',
        frequency: ['Real time'],
        selected_targets: [],
      }),
    ).toMatchObject({ cadence: 'realtime', sourceFolderIds: [] });
    expect(() => capturedRule({ family: 'News' })).toThrow('OUTSIDE_PHASE2');
  });
});

describe('durable local schedule policy', () => {
  it('runs the spring-forward missing time at the next valid minute and fall-back once', () => {
    expect(localOccurrence('2026-03-08', 150, 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(localOccurrence('2026-11-01', 90, 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});
