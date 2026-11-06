import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { EngagementService } from '../engagement.service.js';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
const bytes = Buffer.from('Synthetic scanned file');
const row = {
  s3Key: 'synthetic/file.pdf', source: 'upload', scanStatus: 'clean', contentType: 'application/pdf',
  calculatedSha256: createHash('sha256').update(bytes).digest('hex'),
};
function fixture(versionId: string | undefined = 'verified-version') {
  const state = { current: bytes };
  const send = jest.fn(async (): Promise<{ Body: Readable; ContentLength: number; VersionId: string | undefined }> => ({ Body: Readable.from([state.current]),
    ContentLength: state.current.length, VersionId: versionId }));
  const service = Object.create(EngagementService.prototype) as any;
  Object.assign(service, { bucket: 'synthetic', s3: { send } });
  jest.mocked(getSignedUrl).mockReset().mockImplementation(async (_s3, command: any) =>
    `https://synthetic.invalid/file?versionId=${command.input.VersionId ?? ''}`);
  return { service, send, state };
}

describe('scanned attachment signed reads', () => {
  test('one verified read pins both links to its exact version despite a subsequent overwrite', async () => {
    const h = fixture();
    jest.mocked(getSignedUrl).mockImplementation(async (_s3, command: any) => {
      h.state.current = Buffer.from('unscanned overwrite during signing');
      return `https://synthetic.invalid/file?versionId=${command.input.VersionId}`;
    });
    const links = await h.service.createAttachmentLinks(row);
    expect(links).toEqual({
      downloadUrl: 'https://synthetic.invalid/file?versionId=verified-version',
      previewUrl: 'https://synthetic.invalid/file?versionId=verified-version',
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    const commands = jest.mocked(getSignedUrl).mock.calls.map((call) => (call[1] as any).input);
    expect(commands).toEqual([
      { Bucket: 'synthetic', Key: row.s3Key, VersionId: 'verified-version', ResponseContentDisposition: 'attachment' },
      { Bucket: 'synthetic', Key: row.s3Key, VersionId: 'verified-version', ResponseContentDisposition: 'inline',
        ResponseContentType: 'application/pdf' },
    ]);
  });

  test('changed bytes after a clean scan release neither signed link', async () => {
    const h = fixture();
    h.state.current = Buffer.from('replacement');
    await expect(h.service.createAttachmentLinks(row)).rejects.toMatchObject({
      response: { code: 'ATTACHMENT_CONTENT_CHANGED' },
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test.each(['', 'null', '   '])('missing immutable version %s refuses signed release', async (versionId) => {
    const h = fixture(versionId);
    await expect(h.service.createAttachmentLinks(row)).rejects.toMatchObject({
      response: { code: 'ATTACHMENT_VERSION_UNAVAILABLE' },
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('absent version refuses signed release', async () => {
    const h = fixture();
    h.send.mockImplementation(async () => ({ Body: Readable.from([bytes]), ContentLength: bytes.length,
      VersionId: undefined }));
    await expect(h.service.createAttachmentLinks(row)).rejects.toThrow();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('legacy unscanned links keep key-only signing without fetching bytes', async () => {
    const h = fixture();
    await h.service.createAttachmentLinks({ ...row, scanStatus: null, calculatedSha256: null });
    expect(h.send).not.toHaveBeenCalled();
    for (const call of jest.mocked(getSignedUrl).mock.calls)
      expect((call[1] as any).input).not.toHaveProperty('VersionId');
  });

  test('non-previewable types still receive only a version-bound download', async () => {
    const h = fixture();
    const links = await h.service.createAttachmentLinks({ ...row, contentType: 'image/svg+xml' });
    expect(links.previewUrl).toBeNull();
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });
});
