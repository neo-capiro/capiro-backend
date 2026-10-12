import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { NewsletterImageService } from './newsletter-image.service.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
function fixture() {
  const credentials = {
    resolveNewsletterAltText: jest
      .fn()
      .mockResolvedValue({ secret: 'test-key', model: 'gpt-6-astra' }),
    resolveNewsletterImage: jest
      .fn()
      .mockResolvedValue({ secret: 'test-key', model: 'gpt-image-2.5-sunburst' }),
  };
  const service = new NewsletterImageService(credentials as never);
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })),
    );
  return { service, credentials, fetchMock };
}
afterEach(() => jest.restoreAllMocks());
describe('newsletter OpenAI image editing', () => {
  it('uses the current tenant credential, a dedicated image model and multipart image bytes', async () => {
    const f = fixture();
    expect(await f.service.refine('tenant-1', png, ' Use a blue background ', 1)).toEqual([png]);
    expect(f.credentials.resolveNewsletterImage).toHaveBeenCalledWith('tenant-1');
    const [url, request] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(request?.headers).toEqual({ Authorization: 'Bearer test-key' });
    const form = request?.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(form.get('prompt')).toBe('Use a blue background');
    expect(form.get('n')).toBe('1');
    expect(form.get('output_format')).toBe('png');
    expect(Buffer.from(await (form.get('image[]') as Blob).arrayBuffer())).toEqual(png);
  });
  it('rejects invalid bytes, excessive size and unsupported counts before spending API usage', async () => {
    const f = fixture();
    for (const image of [Buffer.from('<svg></svg>'), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
      await expect(f.service.refine('tenant', image, 'Edit', 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    await expect(f.service.refine('tenant', png, 'Edit', 9 as 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it('does not call OpenAI when credentials are missing', async () => {
    const f = fixture();
    f.credentials.resolveNewsletterImage.mockResolvedValue(null);
    await expect(f.service.refine('tenant', png, 'Edit', 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it('returns four validated image options when requested', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: Array.from({ length: 4 }, () => ({ b64_json: png.toString('base64') })),
        }),
      ),
    );
    expect(await f.service.refine('tenant', png, 'Edit', 4)).toHaveLength(4);
    expect((f.fetchMock.mock.calls[0]![1]?.body as FormData).get('n')).toBe('4');
  });
  it('rejects image URLs and malformed output instead of fetching untrusted output locations', async () => {
    const f = fixture();
    for (const item of [
      { url: 'http://127.0.0.1/private' },
      { b64_json: Buffer.from('not an image').toString('base64') },
    ]) {
      f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [item] })));
      await expect(f.service.refine('tenant', png, 'Edit', 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });
  it('does not retry a failed paid request or expose its provider error body', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(new Response('private provider details', { status: 429 }));
    await expect(f.service.refine('tenant', png, 'Edit', 1)).rejects.toThrow(
      'OpenAI image usage is currently limited',
    );
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('newsletter OpenAI alt text', () => {
  const result = (text = 'The Capitol dome against a blue sky.') => ({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });
  it('describes image bytes with a tenant credential and a text model without storing the request', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(new Response(JSON.stringify(result())));
    expect(await f.service.describe('tenant-2', png)).toBe('The Capitol dome against a blue sky.');
    expect(f.credentials.resolveNewsletterAltText).toHaveBeenCalledWith('tenant-2');
    const [url, request] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(request?.redirect).toBe('error');
    const body = JSON.parse(request?.body as string);
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      reasoning: { effort: 'low' },
    });
    expect(body.input[0].content[1].image_url).toBe(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(body.instructions).toContain('Do not invent identities');
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid files and missing credentials before calling the provider', async () => {
    const f = fixture();
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('<svg/>'),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ])
      await expect(f.service.describe('tenant', bytes)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.credentials.resolveNewsletterAltText).not.toHaveBeenCalled();
    f.credentials.resolveNewsletterAltText.mockResolvedValue(null);
    await expect(f.service.describe('tenant', png)).rejects.toThrow('Connect OpenAI');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it('does not apply incomplete, refused, malformed, empty or excessive descriptions', async () => {
    const f = fixture();
    for (const data of [
      { ...result(), status: 'incomplete' },
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 12 }] }],
      },
      { status: 'completed', output: [null] },
      result('  '),
      result('x'.repeat(501)),
      result('bad\u0000text'),
    ]) {
      f.fetchMock.mockResolvedValue(new Response(JSON.stringify(data)));
      await expect(f.service.describe('tenant', png)).rejects.toThrow('usable alt text');
    }
    f.fetchMock.mockResolvedValue(new Response('not json'));
    await expect(f.service.describe('tenant', png)).rejects.toThrow('unreadable alt text');
  });
  it.each([401, 403, 429, 500])(
    'sanitizes provider error %s without automatically retrying',
    async (status) => {
      const f = fixture();
      f.fetchMock.mockResolvedValue(new Response('private provider details', { status }));
      await expect(f.service.describe('tenant', png)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(f.fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it('reports a timed-out request without issuing another paid request', async () => {
    const f = fixture();
    f.fetchMock.mockRejectedValue(new Error('private network details'));
    await expect(f.service.describe('tenant', png)).rejects.toThrow('not retried automatically');
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
});
