import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { InternalTrackerController, SummarizeAlertDto } from './internal-tracker.controller.js';
import type { TrackerSummaryService } from './notifications/tracker-summary.service.js';

const validBody = {
  tenantId: 'tenant-1',
  displayNum: 'H.R. 1',
  billTitle: 'A bill to do things',
  label: 'Passed a chamber',
  actionText: 'On passage Passed by recorded vote: 219 - 210.',
};

describe('InternalTrackerController', () => {
  it('requires tenantId, displayNum, label, and actionText (handler-level guard)', async () => {
    // These bodies would be rejected by the global ValidationPipe in prod; the
    // casts unit-test the handler's OWN defensive guards (which also reject
    // whitespace-only values that pass @IsString), independent of the pipe.
    const summaries = { summarize: jest.fn() } as unknown as TrackerSummaryService;
    const controller = new InternalTrackerController(summaries);
    await expect(controller.summarize({} as unknown as SummarizeAlertDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.summarize({ tenantId: 'tenant-1' } as unknown as SummarizeAlertDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    // displayNum/label/actionText all required — whitespace-only is rejected too
    await expect(controller.summarize({ ...validBody, actionText: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does NOT require billTitle (some bills carry a null title)', async () => {
    const summarize = jest.fn().mockResolvedValue('A summary.');
    const summaries = { summarize } as unknown as TrackerSummaryService;
    const controller = new InternalTrackerController(summaries);
    const result = await controller.summarize({ ...validBody, billTitle: '' });
    expect(result).toEqual({ summary: 'A summary.' });
    expect(summarize).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      displayNum: 'H.R. 1',
      billTitle: '',
      label: 'Passed a chamber',
      actionText: 'On passage Passed by recorded vote: 219 - 210.',
      // §4.3 (Gate D): always forwarded, empty when the caller sends neither.
      allowedNextSteps: [],
      blockedBy: [],
    });
  });

  it('passes the trimmed fields to TrackerSummaryService and returns its summary', async () => {
    const summarize = jest.fn().mockResolvedValue('The House passed it 219-210.');
    const summaries = { summarize } as unknown as TrackerSummaryService;
    const controller = new InternalTrackerController(summaries);

    const result = await controller.summarize({
      tenantId: '  tenant-1  ',
      displayNum: '  H.R. 1 ',
      billTitle: ' A bill ',
      label: ' Passed a chamber ',
      actionText: ' On passage... ',
    });
    expect(summarize).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      displayNum: 'H.R. 1',
      billTitle: 'A bill',
      label: 'Passed a chamber',
      actionText: 'On passage...',
      // §4.3 (Gate D): always forwarded, empty when the caller sends neither.
      allowedNextSteps: [],
      blockedBy: [],
    });
    expect(result).toEqual({ summary: 'The House passed it 219-210.' });
  });

  it('propagates a null summary (fail-safe: disabled flag / no key / provider error)', async () => {
    const summaries = {
      summarize: jest.fn().mockResolvedValue(null),
    } as unknown as TrackerSummaryService;
    const controller = new InternalTrackerController(summaries);
    expect(await controller.summarize(validBody)).toEqual({ summary: null });
  });

  // The app's global ValidationPipe runs whitelist + forbidNonWhitelisted
  // (main.ts). Without class-validator decorators on the DTO, EVERY body key is
  // "non-whitelisted" and the pipe 400s before the handler runs — silently
  // breaking the feature (the intel-api client fails soft to no summary). This
  // asserts the decorators keep a real payload valid and still reject junk keys.
  describe('DTO passes the app global ValidationPipe (whitelist + forbidNonWhitelisted)', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    });
    const meta = { type: 'body' as const, metatype: SummarizeAlertDto };

    it('accepts the exact payload the intel-api client sends', async () => {
      const out = await pipe.transform({ ...validBody }, meta);
      expect(out).toBeInstanceOf(SummarizeAlertDto);
      expect(out.tenantId).toBe('tenant-1');
      expect(out.actionText).toBe(validBody.actionText);
    });

    it('accepts a payload with billTitle omitted (optional)', async () => {
      const { billTitle: _omit, ...noTitle } = validBody;
      await expect(pipe.transform(noTitle, meta)).resolves.toBeInstanceOf(SummarizeAlertDto);
    });

    it('rejects an unexpected/extra key (forbidNonWhitelisted)', async () => {
      await expect(pipe.transform({ ...validBody, evil: 'x' }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a non-string required field', async () => {
      await expect(pipe.transform({ ...validBody, tenantId: 123 }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * §4.3 (Gate D b-7 case 6) — THE regression this test exists for.
     *
     * intel-api now sends allowedNextSteps + blockedBy. If the DTO does not
     * declare them, forbidNonWhitelisted 400s, AlertSummaryClient fails soft,
     * and EVERY alert summary silently becomes null. Nothing errors, nothing
     * alarms — the feature just stops. Hence an explicit accept-test.
     */
    it('accepts the §4.3 allowedNextSteps + blockedBy payload', async () => {
      await expect(
        pipe.transform(
          {
            ...validBody,
            allowedNextSteps: ['Referral in the other chamber', 'Conference to resolve differences'],
            blockedBy: ['The governing rule was rejected, so floor consideration cannot proceed under it'],
          },
          meta,
        ),
      ).resolves.toBeInstanceOf(SummarizeAlertDto);
    });

    it('accepts empty §4.3 arrays (the "not established" case)', async () => {
      await expect(
        pipe.transform({ ...validBody, allowedNextSteps: [], blockedBy: [] }, meta),
      ).resolves.toBeInstanceOf(SummarizeAlertDto);
    });

    it('still rejects a malformed §4.3 payload', async () => {
      await expect(
        pipe.transform({ ...validBody, allowedNextSteps: 'Floor vote' }, meta),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform({ ...validBody, allowedNextSteps: [1, 2] }, meta),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('passes the §4.3 step set through to TrackerSummaryService', async () => {
    const summarize = jest.fn().mockResolvedValue('The House rejected the governing rule.');
    const summaries = { summarize } as unknown as TrackerSummaryService;
    const controller = new InternalTrackerController(summaries);
    await controller.summarize({
      ...validBody,
      allowedNextSteps: ['New rule from the Rules Committee'],
      blockedBy: ['The governing rule was rejected, so floor consideration cannot proceed under it'],
    });
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedNextSteps: ['New rule from the Rules Committee'],
        blockedBy: [
          'The governing rule was rejected, so floor consideration cannot proceed under it',
        ],
      }),
    );
  });

  it('defaults the §4.3 fields to empty for a caller that has not been upgraded', async () => {
    const summarize = jest.fn().mockResolvedValue('x');
    const summaries = { summarize } as unknown as TrackerSummaryService;
    const controller = new InternalTrackerController(summaries);
    await controller.summarize({ ...validBody });
    // Absent === empty === "the next step is NOT established": the safe default.
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ allowedNextSteps: [], blockedBy: [] }),
    );
  });
});
