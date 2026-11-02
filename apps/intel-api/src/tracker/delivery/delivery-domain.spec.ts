import { mergeRecipients, normalizeEmail, RecipientsService } from './recipients.service.js';
import { capturedRule } from './record-rule.service.js';
import { localOccurrence } from './delivery-schedule.js';
import { legislativeAppOrigin } from './delivery-domain.js';
import { renderedAgenda } from '../calendar/agenda-rule.service.js';

test('retained links prefer the new origin, retain the configured old origin, and default to app.capiro.ai', () => {
  const before = { ...process.env };
  try {
    delete process.env.LEGISLATIVE_APP_ORIGIN;
    delete process.env.REPORT_APP_ORIGIN;
    expect(legislativeAppOrigin()).toBe('https://app.capiro.ai');
    process.env.REPORT_APP_ORIGIN = 'https://existing.example.invalid///';
    expect(legislativeAppOrigin()).toBe('https://existing.example.invalid');
    expect(
      JSON.stringify(
        renderedAgenda(
          { after: { title: 'Synthetic agenda' }, hearingId: 'event-one' },
          ['bill-one'],
          ['folder-one'],
        ),
      ),
    ).toContain('https://existing.example.invalid');
    process.env.LEGISLATIVE_APP_ORIGIN = 'https://current.example.invalid/';
    expect(legislativeAppOrigin()).toBe('https://current.example.invalid');
  } finally {
    process.env = before;
  }
});

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

describe('retained recipient selection', () => {
  const ctx = { tenantId: 'tenant-a', clerkUserId: 'owner-a', role: null };
  const recipients = new RecipientsService({} as never);
  it('denies another owner’s private list before resolving its contacts', async () => {
    const tx = {
      legiWatchReportList: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'private-list',
          private: true,
          ownerClerkId: 'owner-b',
          contactIds: ['contact-a'],
        }),
      },
      legiWatchReportContact: { findFirst: jest.fn() },
    };
    await expect(
      recipients.resolve(tx as never, ctx, [{ kind: 'list', id: 'private-list', role: 'bcc' }]),
    ).rejects.toThrow('LIST_NOT_AUTHORIZED');
    expect(tx.legiWatchReportContact.findFirst).not.toHaveBeenCalled();
  });
  it('honors destination opt-outs even for a manually entered address', async () => {
    const tx = { legiWatchReportContact: { count: jest.fn().mockResolvedValue(1) } };
    await expect(
      recipients.resolve(tx as never, ctx, [
        { kind: 'manual', email: 'recipient@example.invalid', role: 'bcc' },
      ]),
    ).rejects.toThrow('DESTINATION_OPTED_OUT');
    expect(tx.legiWatchReportContact.count).toHaveBeenCalledWith({
      where: {
        tenantId: ctx.tenantId,
        email: { equals: 'recipient@example.invalid', mode: 'insensitive' },
        optedOut: true,
      },
    });
  });
});
