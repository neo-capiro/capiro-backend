import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  ALERT_TRIGGER_KEYS,
  FEEDBACK_REASONS,
  PutAlertPrefsDto,
  RecordFeedbackDto,
  TrackBillDto,
  PutWatchlistDto,
  WATCHLIST_TERM_TYPES,
} from '../src/tracker/tracker.dto.js';

/**
 * Gate A, P1-03/P1-04 — the global ValidationPipe config (whitelist +
 * forbidNonWhitelisted + transform), exercised directly against the new DTOs.
 * This is the regression lock that stops the DTOs from 400-ing real traffic:
 * case 15 below is the exact payload prefsToIntel (apps/web
 * intel-tracker-api.ts:279-293) produces today.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function validate(metatype: new (...args: unknown[]) => unknown, value: unknown) {
  return pipe.transform(value, { type: 'body', metatype: metatype as any, data: '' });
}

describe('PutAlertPrefsDto', () => {
  it('rejects an invalid email address', async () => {
    await expect(
      validate(PutAlertPrefsDto, { emailAddress: 'not-an-email' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a null email address (cleared field)', async () => {
    await expect(validate(PutAlertPrefsDto, { emailAddress: null })).resolves.toBeDefined();
  });

  it('accepts an empty-string email address (the pre-typing state)', async () => {
    await expect(validate(PutAlertPrefsDto, { emailAddress: '' })).resolves.toBeDefined();
  });

  it('accepts a realistic long email near the max valid total length, and rejects a clearly oversized string', async () => {
    // class-validator's @IsEmail() enforces RFC 5321's real ~254-char total
    // ceiling regardless of the local/domain split, well under the DTO's own
    // @MaxLength(320) — so a literal "320 passes, 321 rejects" boundary is
    // unreachable once @IsEmail() is combined with @MaxLength(320); this
    // exercises the realistic long-address path instead (verified 2026-07-25
    // against class-validator's isEmail directly: 254 chars passes, 255 fails).
    const domainOfLength = (n: number) => {
      let domain = '';
      let remaining = n;
      while (remaining > 0) {
        if (domain) {
          domain += '.';
          remaining -= 1;
          if (remaining <= 0) break;
        }
        const take = Math.min(63, remaining);
        domain += 'b'.repeat(take);
        remaining -= take;
      }
      return domain;
    };
    const local = 'a'.repeat(64);
    const validLongEmail = `${local}@${domainOfLength(189)}`; // 64 + 1 + 189 = 254
    expect(validLongEmail.length).toBe(254);
    await expect(
      validate(PutAlertPrefsDto, { emailAddress: validLongEmail }),
    ).resolves.toBeDefined();

    const oversized = `${'a'.repeat(64)}@${'b'.repeat(260)}.com`;
    expect(oversized.length).toBeGreaterThan(320);
    await expect(
      validate(PutAlertPrefsDto, { emailAddress: oversized }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown cadence value', async () => {
    await expect(
      validate(PutAlertPrefsDto, { emailCadence: 'hourly' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown trigger key', async () => {
    await expect(
      validate(PutAlertPrefsDto, { triggers: ['newMatch', 'bogusKey'] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown materiality value', async () => {
    await expect(
      validate(PutAlertPrefsDto, { materiality: 'urgent' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a malformed quiet-hours value and accepts a well-formed one', async () => {
    await expect(
      validate(PutAlertPrefsDto, { quietHoursStart: '25:00' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      validate(PutAlertPrefsDto, { quietHoursStart: '22:00' }),
    ).resolves.toBeDefined();
  });

  it('accepts a single-digit hour (Configure panel\'s quiet-hours input is free text, not a time picker)', async () => {
    await expect(
      validate(PutAlertPrefsDto, { quietHoursStart: '2:00' }),
    ).resolves.toBeDefined();
  });

  it('accepts the exact payload prefsToIntel produces (regression lock)', async () => {
    const prefsToIntelPayload = {
      triggers: [...ALERT_TRIGGER_KEYS],
      materiality: 'medium',
      emailEnabled: true,
      emailAddress: 'analyst@example.com',
      emailCadence: 'daily',
      smsEnabled: false,
      smsPhone: null,
      smsCadence: 'realtime',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      jurisdictions: [],
    };
    await expect(validate(PutAlertPrefsDto, prefsToIntelPayload)).resolves.toBeDefined();
  });
});

describe('TrackBillDto', () => {
  it('rejects an extra, non-whitelisted property', async () => {
    await expect(
      validate(TrackBillDto, { billId: 'x', evil: 1 }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('RecordFeedbackDto', () => {
  it('rejects an unknown feedback signal', async () => {
    await expect(
      validate(RecordFeedbackDto, { targetRef: '119-hr-1234', signal: 'nonsense' }),
    ).rejects.toThrow(BadRequestException);
  });

  // §4.10 (Gate E phase f, f-7 case 1).
  it.each(FEEDBACK_REASONS)('accepts the structured dismiss reason "%s"', async (reason) => {
    await expect(
      validate(RecordFeedbackDto, {
        targetRef: '119-hr-1234',
        signal: 'marked_irrelevant',
        reason,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown dismiss reason', async () => {
    await expect(
      validate(RecordFeedbackDto, {
        targetRef: '119-hr-1234',
        signal: 'marked_irrelevant',
        reason: 'the_analyst_just_felt_like_it',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts matchedTags as an array of topic labels', async () => {
    await expect(
      validate(RecordFeedbackDto, {
        targetRef: '119-hr-1234',
        signal: 'marked_irrelevant',
        matchedTags: ['data center load', 'permitting'],
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a non-string matchedTags entry', async () => {
    await expect(
      validate(RecordFeedbackDto, {
        targetRef: '119-hr-1234',
        signal: 'marked_irrelevant',
        matchedTags: [42],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

/**
 * Gate B phase a (P0-03/P0-04/P0-05) — the watchlist PUT DTOs, exercised
 * through the same global ValidationPipe config as above. None of the
 * existing intel-api tests exercise this pipe for the watchlist route: every
 * tracker-watchlist.spec.ts test calls TrackerWatchlistService.putWatchlist()
 * directly with a hand-typed object, bypassing class-validator entirely. This
 * is the regression lock that stops these DTOs from 400-ing real traffic.
 */
describe('PutWatchlistDto', () => {
  it('accepts the exact payload watchlistToIntel produces (regression lock)', async () => {
    // apps/web/src/pages/clients/tracker/intel-tracker-api.ts watchlistToIntel()
    const payload = {
      issueAreas: ['Energy & Utilities'],
      jurisdictions: ['CA', 'TX'],
      topics: [
        {
          label: 'data center load',
          issueArea: 'Energy & Utilities',
          position: 'monitor',
          priority: 'high',
          terms: [
            { termType: 'synonym', value: 'hyperscale demand' },
            { termType: 'entity', value: 'PJM' },
            { termType: 'risk', value: 'grid strain' },
            { termType: 'company', value: 'RTX' },
            { termType: 'topic', value: 'AI' },
          ],
        },
      ],
    };
    await expect(validate(PutWatchlistDto, payload)).resolves.toBeDefined();
  });

  it('accepts every one of the 15 canonical term types', async () => {
    for (const termType of WATCHLIST_TERM_TYPES) {
      await expect(
        validate(PutWatchlistDto, {
          topics: [{ label: 'x', terms: [{ termType, value: 'some value' }] }],
        }),
      ).resolves.toBeDefined();
    }
  });

  it('rejects an unknown term type', async () => {
    await expect(
      validate(PutWatchlistDto, {
        topics: [{ label: 'x', terms: [{ termType: 'bogus_type', value: 'v' }] }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a topic missing a label', async () => {
    await expect(validate(PutWatchlistDto, { topics: [{ terms: [] }] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('cascades nested validation: one invalid term inside an otherwise-valid topic rejects the whole payload', async () => {
    await expect(
      validate(PutWatchlistDto, {
        topics: [
          {
            label: 'valid topic',
            terms: [
              { termType: 'topic', value: 'fine' },
              { termType: 'not-a-real-type', value: 'also fine text' },
            ],
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a negative expectedVersion', async () => {
    await expect(validate(PutWatchlistDto, { expectedVersion: -1 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts expectedVersion 0 and an omitted expectedVersion (unversioned legacy client)', async () => {
    await expect(validate(PutWatchlistDto, { expectedVersion: 0 })).resolves.toBeDefined();
    await expect(validate(PutWatchlistDto, {})).resolves.toBeDefined();
  });

  it('rejects an extra, non-whitelisted top-level property', async () => {
    await expect(validate(PutWatchlistDto, { issueAreas: [], evil: true })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an unknown topic position', async () => {
    await expect(
      validate(PutWatchlistDto, { topics: [{ label: 'x', position: 'bogus' }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a 3-letter jurisdiction code', async () => {
    await expect(validate(PutWatchlistDto, { jurisdictions: ['USA'] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('accepts a renameFrom string (P0-03 item 5, phase d wiring)', async () => {
    await expect(
      validate(PutWatchlistDto, { topics: [{ label: 'grid load', renameFrom: 'data center load' }] }),
    ).resolves.toBeDefined();
  });
});
