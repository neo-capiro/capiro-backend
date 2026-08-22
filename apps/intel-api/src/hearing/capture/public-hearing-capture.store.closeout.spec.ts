import {
  captureAllPublicEventsEnabled,
  isTerminalCaptureStatus,
  publicCaptureLegacyDomainStatus,
  publicCaptureStorageStatus,
  publicCaptureTerminalReasonCode,
} from './public-hearing-capture.store.js';

describe('public hearing capture closeout contract', () => {
  it('keeps capture-all dark unless explicitly enabled', () => {
    expect(captureAllPublicEventsEnabled(undefined)).toBe(false);
    expect(captureAllPublicEventsEnabled('')).toBe(false);
    expect(captureAllPublicEventsEnabled('false')).toBe(false);
    expect(captureAllPublicEventsEnabled('0')).toBe(false);
    expect(captureAllPublicEventsEnabled('true')).toBe(true);
    expect(captureAllPublicEventsEnabled('1')).toBe(true);
    expect(captureAllPublicEventsEnabled('enabled')).toBe(true);
  });

  it('preserves exact domain states even when legacy storage collapses them', () => {
    expect(publicCaptureStorageStatus('PREPARING')).toBe('paused');
    expect(publicCaptureStorageStatus('WAITING_FOR_STREAM')).toBe('paused');
    expect(publicCaptureStorageStatus('READY')).toBe('leased');
    expect(publicCaptureStorageStatus('RECOVERING')).toBe('capturing');
    expect(publicCaptureStorageStatus('FINALIZING')).toBe('paused');
    expect(publicCaptureStorageStatus('COMPLETE_WITH_GAPS')).toBe('ended');
    expect(publicCaptureStorageStatus('CANCELED')).toBe('no_stream');

    expect(publicCaptureLegacyDomainStatus('ended')).toBe('COMPLETE');
    expect(publicCaptureLegacyDomainStatus('no_stream')).toBe('BLOCKED');
  });

  it('identifies only final capture states as terminal', () => {
    for (const status of [
      'SCHEDULED',
      'PREPARING',
      'WAITING_FOR_STREAM',
      'READY',
      'CAPTURING',
      'RECOVERING',
      'FINALIZING',
    ] as const) {
      expect(isTerminalCaptureStatus(status)).toBe(false);
    }
    for (const status of [
      'COMPLETE',
      'COMPLETE_WITH_GAPS',
      'FAILED',
      'CANCELED',
      'BLOCKED',
    ] as const) {
      expect(isTerminalCaptureStatus(status)).toBe(true);
    }
  });

  it('assigns an explicit reason code to every terminal outcome', () => {
    const now = new Date('2026-08-21T20:00:00.000Z');
    expect(
      publicCaptureTerminalReasonCode({ status: 'COMPLETE', version: 2, updatedAt: now }),
    ).toBe('CAPTURE_COMPLETE');
    expect(
      publicCaptureTerminalReasonCode({
        status: 'COMPLETE_WITH_GAPS',
        version: 2,
        updatedAt: now,
      }),
    ).toBe('CAPTURE_COMPLETE_WITH_GAPS');
    expect(
      publicCaptureTerminalReasonCode({
        status: 'FAILED',
        version: 2,
        updatedAt: now,
        failureCode: 'DEEPGRAM_CONNECTION_FAILED',
      }),
    ).toBe('DEEPGRAM_CONNECTION_FAILED');
    expect(
      publicCaptureTerminalReasonCode({ status: 'FAILED', version: 2, updatedAt: now }),
    ).toBe('CAPTURE_FAILED');
    expect(
      publicCaptureTerminalReasonCode({ status: 'CANCELED', version: 2, updatedAt: now }),
    ).toBe('EVENT_CANCELED');
    expect(
      publicCaptureTerminalReasonCode({ status: 'BLOCKED', version: 2, updatedAt: now }),
    ).toBe('CAPTURE_BLOCKED');
  });
});
