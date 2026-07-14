import { isAllowedAttachmentContentType } from './engagement.service.js';

describe('isAllowedAttachmentContentType — engagement attachment allowlist', () => {
  test('accepts the advertised document types', () => {
    expect(isAllowedAttachmentContentType('application/pdf')).toBe(true);
    expect(isAllowedAttachmentContentType('application/msword')).toBe(true);
    expect(
      isAllowedAttachmentContentType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
    expect(isAllowedAttachmentContentType('text/plain')).toBe(true);
  });

  test('accepts PowerPoint, Excel, and CSV (capability + client Documents advertise these)', () => {
    expect(isAllowedAttachmentContentType('application/vnd.ms-powerpoint')).toBe(true);
    expect(
      isAllowedAttachmentContentType(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe(true);
    expect(isAllowedAttachmentContentType('application/vnd.ms-excel')).toBe(true);
    expect(
      isAllowedAttachmentContentType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe(true);
    expect(isAllowedAttachmentContentType('text/csv')).toBe(true);
  });

  test('accepts any image/*, plus audio/* and video/* for the debrief transcript flow', () => {
    expect(isAllowedAttachmentContentType('image/png')).toBe(true);
    expect(isAllowedAttachmentContentType('image/heic')).toBe(true);
    expect(isAllowedAttachmentContentType('audio/webm')).toBe(true);
    expect(isAllowedAttachmentContentType('video/mp4')).toBe(true);
  });

  test('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isAllowedAttachmentContentType('Application/PDF')).toBe(true);
    expect(isAllowedAttachmentContentType(' image/png ')).toBe(true);
  });

  test('rejects application/octet-stream (the FE fallback for unknown drag-dropped types)', () => {
    expect(isAllowedAttachmentContentType('application/octet-stream')).toBe(false);
  });

  test('rejects types no upload flow advertises', () => {
    expect(isAllowedAttachmentContentType('application/zip')).toBe(false);
    expect(isAllowedAttachmentContentType('application/x-msdownload')).toBe(false);
    expect(isAllowedAttachmentContentType('text/html')).toBe(false);
    expect(isAllowedAttachmentContentType('')).toBe(false);
  });

  test('rejects image/svg+xml despite the image/ prefix (scriptable, replays inline from S3)', () => {
    expect(isAllowedAttachmentContentType('image/svg+xml')).toBe(false);
    expect(isAllowedAttachmentContentType(' Image/SVG+XML ')).toBe(false);
  });

  test('rejects image/svg+xml when disguised with a parameter (the exact-match bypass)', () => {
    // Regression: an exact-match block-list check missed these because the
    // parameter changed the string, but the image/ prefix allow still matched —
    // the object was then stored + replayed from S3 as image/svg+xml and executed
    // its embedded <script> when opened inline. Selection is now on the essence.
    expect(isAllowedAttachmentContentType('image/svg+xml; charset=utf-8')).toBe(false);
    expect(isAllowedAttachmentContentType('IMAGE/SVG+XML;charset=utf-8')).toBe(false);
    expect(isAllowedAttachmentContentType('image/svg+xml;')).toBe(false);
    expect(isAllowedAttachmentContentType('image/svg+xml ; charset=utf-8')).toBe(false);
    // text/html with a param must stay rejected too (not in the allow-list).
    expect(isAllowedAttachmentContentType('text/html; charset=utf-8')).toBe(false);
  });

  test('accepts legitimate types that carry a charset/parameter (browsers add these)', () => {
    expect(isAllowedAttachmentContentType('text/csv; charset=utf-8')).toBe(true);
    expect(isAllowedAttachmentContentType('text/plain;charset=UTF-8')).toBe(true);
    expect(isAllowedAttachmentContentType('image/png; charset=binary')).toBe(true);
  });
});
