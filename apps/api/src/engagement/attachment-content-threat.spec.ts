import { describe, expect, test } from '@jest/globals';
import { AttachmentContentService } from './attachment-content.service.js';

const service = new AttachmentContentService();

const base = {
  id: 'attachment-1',
  fileName: 'brief.pdf',
  contentType: 'application/pdf',
  lifecycleStatus: 'ready',
  scanStatus: null,
  verifiedContentType: 'application/pdf',
};

describe('AttachmentContentService.readiness — authoritative threat verdicts', () => {
  test('a known malware threat is blocked even when scanning is optional', () => {
    expect(service.readiness({ ...base, scanStatus: 'threat' }, false)).toEqual({
      usable: false,
      code: 'ATTACHMENT_SCAN_THREAT',
      disclosure: 'This file was flagged as malware and cannot be used or sent.',
    });
  });

  test('a known malware threat is blocked when scanning is required', () => {
    expect(service.readiness({ ...base, scanStatus: 'threat' }, true)).toEqual({
      usable: false,
      code: 'ATTACHMENT_SCAN_THREAT',
      disclosure: 'This file was flagged as malware and cannot be used or sent.',
    });
  });

  test('optional scanning still permits a never-scanned file with an honest disclosure', () => {
    expect(service.readiness(base, false)).toEqual({
      usable: true,
      code: null,
      disclosure: 'This file predates malware scanning and was never scanned.',
    });
  });
});
