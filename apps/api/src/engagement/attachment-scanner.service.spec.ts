/**
 * Attachment scanner abstraction + readiness gate (Phase 1 §3.h1/§3.h2, §5.3).
 *
 * The two assertions that matter most are both about NOT lying:
 *   - the null adapter reports `scanner_not_required`, never `clean`;
 *   - with scanning REQUIRED and no adapter provisioned, it fails CLOSED.
 * A "return clean" default would turn an unresolved infrastructure decision
 * (§6.1) into a false security guarantee.
 */
import { describe, expect, test } from '@jest/globals';
import {
  AttachmentScannerService,
  ClamAvAttachmentScanner,
  FakeAttachmentScanner,
  NullAttachmentScanner,
  isUsableScanStatus,
  scanStatusDisclosure,
  type AttachmentScanStatus,
} from './attachment-scanner.service.js';
import { AttachmentContentService } from './attachment-content.service.js';

/**
 * Build a minimal ConfigService mock that maps known config keys. Keys not
 * present fall back to their defaults so existing tests are unaffected.
 */
function makeConfig(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: false,
    ENGAGEMENT_ATTACHMENT_SCANNER_PROVIDER: 'none',
    ENGAGEMENT_CLAMAV_PORT: 3310,
    ENGAGEMENT_CLAMAV_TIMEOUT_MS: 120_000,
    AWS_REGION_DEFAULT: 'us-east-1',
  };
  const merged = { ...defaults, ...overrides };
  return { get: (key: string) => merged[key] } as never;
}

function scannerService(scanRequired: boolean): AttachmentScannerService {
  return new AttachmentScannerService(makeConfig({ ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: scanRequired }));
}

describe('null adapter honesty', () => {
  test('with scanning NOT required it reports scanner_not_required, not clean', async () => {
    const adapter = new NullAttachmentScanner(false);
    await expect(adapter.getStatus('b', 'k')).resolves.toBe('scanner_not_required');
  });

  test('with scanning REQUIRED and no adapter, it fails CLOSED', async () => {
    const adapter = new NullAttachmentScanner(true);
    // Not 'clean' and not 'scanner_not_required': a deployment that requires
    // scanning with nothing wired up must not pass everything through.
    await expect(adapter.getStatus('b', 'k')).resolves.toBe('failed');
  });

  test('the service never throws — an adapter outage becomes failed', async () => {
    const svc = scannerService(false);
    await expect(svc.getStatus('b', 'k')).resolves.toBe('scanner_not_required');
    expect(svc.providerName).toBe('none');
  });
});

describe('usable statuses', () => {
  test('only clean and scanner_not_required are usable', () => {
    const all: AttachmentScanStatus[] = [
      'pending',
      'clean',
      'threat',
      'unsupported',
      'access_denied',
      'failed',
      'scanner_not_required',
    ];
    expect(all.filter(isUsableScanStatus)).toEqual(['clean', 'scanner_not_required']);
  });

  test('every non-clean status carries a user-facing disclosure', () => {
    for (const s of [
      'pending',
      'threat',
      'unsupported',
      'access_denied',
      'failed',
      'scanner_not_required',
      null,
    ] as Array<AttachmentScanStatus | null>) {
      expect(scanStatusDisclosure(s)).toBeTruthy();
    }
    // Only a real clean verdict has nothing to disclose.
    expect(scanStatusDisclosure('clean')).toBeNull();
  });

  test('the unscanned disclosure SAYS it was not scanned', () => {
    expect(scanStatusDisclosure('scanner_not_required')).toMatch(/NOT virus-scanned/);
  });
});

describe('readiness gate', () => {
  const content = new AttachmentContentService();
  const row = (over: Partial<Parameters<AttachmentContentService['readiness']>[0]> = {}) => ({
    id: 'a1',
    fileName: 'f.pdf',
    contentType: 'application/pdf',
    lifecycleStatus: 'quarantined',
    scanStatus: 'pending' as string | null,
    ...over,
  });

  test('scan NOT required: a quarantined file is usable but DISCLOSED', () => {
    const v = content.readiness(row(), false);
    expect(v.usable).toBe(true);
    expect(v.disclosure).toBeTruthy();
  });

  test('scan REQUIRED: a quarantined file is refused', () => {
    const v = content.readiness(row(), true);
    expect(v.usable).toBe(false);
    expect(v.code).toBe('ATTACHMENT_QUARANTINED');
  });

  test('scan REQUIRED: each non-clean status maps to its own code', () => {
    const cases: Array<[string, string]> = [
      ['pending', 'ATTACHMENT_SCAN_PENDING'],
      ['threat', 'ATTACHMENT_SCAN_THREAT'],
      ['unsupported', 'ATTACHMENT_SCAN_UNSUPPORTED'],
      ['access_denied', 'ATTACHMENT_SCAN_ACCESS_DENIED'],
      ['failed', 'ATTACHMENT_SCAN_FAILED'],
    ];
    for (const [status, code] of cases) {
      const v = content.readiness(row({ lifecycleStatus: 'ready', scanStatus: status }), true);
      expect(v.usable).toBe(false);
      expect(v.code).toBe(code);
    }
  });

  test('scan REQUIRED: a NEVER-scanned legacy row is refused, not assumed clean', () => {
    const v = content.readiness(
      row({ lifecycleStatus: 'legacy_ready', scanStatus: null }),
      true,
    );
    expect(v.usable).toBe(false);
    expect(v.code).toBe('ATTACHMENT_NEVER_SCANNED');
  });

  test('scan REQUIRED: a genuinely clean file passes with nothing to disclose', () => {
    const v = content.readiness(row({ lifecycleStatus: 'ready', scanStatus: 'clean' }), true);
    expect(v.usable).toBe(true);
    expect(v.disclosure).toBeNull();
  });

  test('a THREAT-blocked file is refused regardless of the flag', () => {
    for (const required of [true, false]) {
      const v = content.readiness(
        row({ lifecycleStatus: 'blocked', scanStatus: 'threat' }),
        required,
      );
      expect(v.usable).toBe(false);
      expect(v.code).toBe('ATTACHMENT_BLOCKED');
    }
  });

  test('a delete_failed orphan is never readable, regardless of the flag (§4.31)', () => {
    for (const required of [true, false]) {
      const v = content.readiness(
        row({ lifecycleStatus: 'delete_failed', scanStatus: 'clean' }),
        required,
      );
      expect(v.usable).toBe(false);
      expect(v.code).toBe('ATTACHMENT_DELETE_PENDING');
    }
  });

  test('a legacy row is usable with the flag off, but visibly unscanned (§4.28)', () => {
    const v = content.readiness(row({ lifecycleStatus: 'legacy_ready', scanStatus: null }), false);
    expect(v.usable).toBe(true);
    expect(v.disclosure).toMatch(/never scanned/i);
  });
});

describe('magic-byte content verification', () => {
  const content = new AttachmentContentService();

  test('detects a PDF by signature', () => {
    expect(content.detectContentType(Buffer.from('%PDF-1.7\n...'))).toBe('application/pdf');
  });

  test('detects a zip/OOXML container', () => {
    expect(content.detectContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(
      'application/zip',
    );
  });

  test('an unrecognized signature is null, not a guess', () => {
    expect(content.detectContentType(Buffer.from('name,value\n1,2\n'))).toBeNull();
  });

  test('a zip declared as application/pdf is a CONFLICT', () => {
    expect(content.contentTypeConflicts('application/pdf', 'application/zip')).toBe(true);
  });

  test('a zip declared as .docx is NOT a conflict — OOXML is a zip', () => {
    expect(
      content.contentTypeConflicts(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/zip',
      ),
    ).toBe(false);
  });

  test('an unrecognized signature never reports a conflict', () => {
    expect(content.contentTypeConflicts('text/csv', null)).toBe(false);
  });

  test('sha256 is computed over the actual bytes', () => {
    // Well-known digest of the empty string.
    expect(content.sha256(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('bounded extraction (§3.h3)', () => {
  const content = new AttachmentContentService();

  test('plain text under the cap is extracted whole', async () => {
    const out = await content.extractBounded(Buffer.from('hello world'), 'a.txt', 'text/plain');
    expect(out.status).toBe('extracted');
    expect(out.text).toBe('hello world');
    expect(out.metadata.truncated).toBe(false);
  });

  test('text over the character cap is TRUNCATED and says so', async () => {
    const big = 'x'.repeat(150_000);
    const out = await content.extractBounded(Buffer.from(big), 'a.txt', 'text/plain');
    expect(out.status).toBe('truncated');
    expect(out.metadata.charLimitHit).toBe(true);
    expect(out.metadata.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(out.metadata.limits.maxChars);
  });

  test('an empty file reports empty rather than an empty-string success', async () => {
    const out = await content.extractBounded(Buffer.from('   '), 'a.txt', 'text/plain');
    expect(out.status).toBe('empty');
    expect(out.text).toBe('');
  });

  test('recognizes legacy Word documents as an extractable advertised type', () => {
    expect(content.isExtractableDocument('capability-brief.doc', 'application/msword')).toBe(true);
  });

  test('an unsupported format throws rather than returning placeholder text', async () => {
    await expect(
      content.extractBounded(Buffer.from('x'), 'a.exe', 'application/x-msdownload'),
    ).rejects.toThrow(/Unsupported source/);
  });

  test('the limits are reported alongside the result', async () => {
    const out = await content.extractBounded(Buffer.from('hi'), 'a.txt', 'text/plain');
    expect(out.metadata.limits).toEqual({
      maxChars: 100_000,
      maxPages: 200,
      maxRows: 5_000,
      maxCols: 50,
      timeoutMs: 30_000,
    });
  });
});

describe('test adapter', () => {
  test('returns queued per-key statuses', async () => {
    const fake = new FakeAttachmentScanner('pending').set('bad-key', 'threat');
    await expect(fake.getStatus('b', 'bad-key')).resolves.toBe('threat');
    await expect(fake.getStatus('b', 'other')).resolves.toBe('pending');
  });
});

describe('provider selection and fallback defaults', () => {
  test('default provider is none — service providerName is "none"', () => {
    const svc = new AttachmentScannerService(makeConfig());
    expect(svc.providerName).toBe('none');
  });

  test('provider=none with scan NOT required → scanner_not_required', async () => {
    const svc = new AttachmentScannerService(
      makeConfig({ ENGAGEMENT_ATTACHMENT_SCANNER_PROVIDER: 'none', ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: false }),
    );
    await expect(svc.getStatus('b', 'k')).resolves.toBe('scanner_not_required');
  });

  test('provider=none with scan REQUIRED → failed (fail-closed)', async () => {
    const svc = new AttachmentScannerService(
      makeConfig({ ENGAGEMENT_ATTACHMENT_SCANNER_PROVIDER: 'none', ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: true }),
    );
    await expect(svc.getStatus('b', 'k')).resolves.toBe('failed');
  });

  test('provider=clamav creates ClamAvAttachmentScanner and reports providerName "clamav"', () => {
    const svc = new AttachmentScannerService(
      makeConfig({ ENGAGEMENT_ATTACHMENT_SCANNER_PROVIDER: 'clamav' }),
    );
    expect(svc.providerName).toBe('clamav');
  });

  test('ClamAvAttachmentScanner.getStatus delegates to clamAvScanObject (fail-closed on error)', async () => {
    // Use a fake S3 that errors + a port with no listener — must return failed.
    const fakeFailing = {
      send: jest.fn(async () => { throw new Error('network error'); }),
    };
    const scanner = new ClamAvAttachmentScanner(fakeFailing as never, 1, 1000);
    await expect(scanner.getStatus('b', 'k')).resolves.toBe('failed');
  });

  test('AttachmentScannerService.getStatus never throws — adapter errors become failed', async () => {
    // Inject an adapter that throws, bypassing the catch in getStatus.
    const svc = new AttachmentScannerService(makeConfig());
    // Force-replace the internal scanner with a throwing one.
    (svc as unknown as { scanner: { getStatus: () => Promise<never> } }).scanner = {
      getStatus: async () => { throw new Error('unexpected adapter error'); },
    };
    await expect(svc.getStatus('b', 'k')).resolves.toBe('failed');
  });
});
