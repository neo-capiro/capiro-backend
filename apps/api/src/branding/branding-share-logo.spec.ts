import { Readable } from 'node:stream';
import { BrandingService } from './branding.service.js';

function fixture() {
  const service = new BrandingService(
    {} as never,
    { get: (key: string) => (key === 'ASSETS_BUCKET' ? 'assets' : 'eu-west-2') } as never,
  );
  const send = jest.spyOn((service as any).s3, 'send');
  return { service, send };
}
describe('frozen share logo', () => {
  it('captures original bytes from an owned logo, including legacy mutable keys', async () => {
    const h = fixture();
    const bytes = Buffer.from('logo-a');
    const body = Readable.from([bytes]);
    h.send.mockResolvedValue({ Body: body, ContentType: 'image/png', ContentLength: bytes.length });
    const first = await h.service.freezeLogoForSharing(
      'one',
      'tenants/one/branding/logo.png',
      'image/png',
    );
    bytes.fill(0);
    expect(first.dataUrl).toBe('data:image/png;base64,bG9nby1h');
    expect(body.destroyed).toBe(true);
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({
      input: { Bucket: 'assets', Key: 'tenants/one/branding/logo.png' },
    });
  });
  it('refuses foreign keys before S3 and refuses incomplete or oversized streams', async () => {
    const h = fixture();
    await expect(
      h.service.freezeLogoForSharing('one', 'tenants/two/branding/logo.png', 'image/png'),
    ).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    const incomplete = Readable.from([Buffer.from('x')]);
    h.send.mockResolvedValueOnce({ Body: incomplete, ContentType: 'image/png', ContentLength: 2 });
    await expect(
      h.service.freezeLogoForSharing('one', 'tenants/one/branding/logo.png', 'image/png'),
    ).rejects.toThrow('Incomplete logo');
    expect(incomplete.destroyed).toBe(true);
    const oversized = Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1)]);
    h.send.mockResolvedValueOnce({ Body: oversized, ContentType: 'image/png', ContentLength: 1 });
    await expect(
      h.service.freezeLogoForSharing('one', 'tenants/one/branding/logo.png', 'image/png'),
    ).rejects.toThrow('Logo is too large');
    expect(oversized.destroyed).toBe(true);
  });
});
