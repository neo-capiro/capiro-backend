import { ServiceUnavailableException } from '@nestjs/common';
import { NewsletterHtmlCheckService } from './newsletter-html-check.service.js';

function fixture(
  settings: Record<string, string | undefined> = {
    MAILTRAP_API_TOKEN: 'sandbox-test-token',
    MAILTRAP_ACCOUNT_ID: '123',
    MAILTRAP_SANDBOX_ID: '456',
  },
) {
  const service = new NewsletterHtmlCheckService({ get: (key: string) => settings[key] } as never);
  const fetchMock = jest.spyOn(global, 'fetch');
  let subject = '';
  fetchMock.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      subject = JSON.parse(options.body as string).subject;
      return new Response(JSON.stringify({ success: true, message_ids: ['opaque-send-id'] }));
    }
    if (String(_url).includes('?search=')) {
      return new Response(
        JSON.stringify([
          { id: 12, subject: 'another message' },
          { id: 99, subject },
        ]),
      );
    }
    return new Response(
      JSON.stringify({ status: 'success', errors: ['Unsupported CSS: display grid'] }),
    );
  });
  return { service, fetchMock };
}

afterEach(() => jest.restoreAllMocks());

describe('newsletter Mailtrap HTML compatibility check', () => {
  it('submits only to the sandbox and analyzes the message identified by this request', async () => {
    const f = fixture();
    const result = await f.service.check('<p>Client update</p>');
    expect(result.issues).toEqual(['Unsupported CSS: display grid']);
    const [url, options] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe('https://sandbox.api.mailtrap.io/api/send/456');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer sandbox-test-token' },
    });
    const sent = JSON.parse(options!.body as string);
    expect(sent).toMatchObject({
      from: { email: 'newsletter-check@example.com' },
      to: [{ email: 'sandbox-preview@example.com' }],
      html: '<p>Client update</p>',
    });
    expect(sent.subject).toMatch(/^Capiro HTML check [a-f0-9-]+$/);
    expect(f.fetchMock.mock.calls[1]![0]).toBe(
      `https://mailtrap.io/api/accounts/123/inboxes/456/messages?search=${encodeURIComponent(sent.subject)}`,
    );
    expect(f.fetchMock.mock.calls[2]![0]).toBe(
      'https://mailtrap.io/api/accounts/123/inboxes/456/messages/99/analyze',
    );
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not make requests without a valid server-side sandbox connection', async () => {
    for (const settings of [
      {},
      {
        MAILTRAP_API_TOKEN: 'token',
        MAILTRAP_ACCOUNT_ID: 'https://other.example',
        MAILTRAP_SANDBOX_ID: '456',
      },
    ]) {
      const f = fixture(settings);
      expect(f.service.available()).toBe(false);
      await expect(f.service.check('<p>Update</p>')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(f.fetchMock).not.toHaveBeenCalled();
    }
  });
  it('reports allowance limits without retrying the submission or exposing provider details', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(new Response('private provider response', { status: 429 }));
    await expect(f.service.check('<p>Update</p>')).rejects.toThrow(
      'sandbox limit has been reached',
    );
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not report a successful check for pending, failed or malformed analysis', async () => {
    const f = fixture();
    for (const report of [
      { status: 'pending' },
      { status: 'error', msg: 'private details' },
      {},
      { status: 'success' },
    ]) {
      f.fetchMock.mockImplementation(async (url, options) => {
        if (options?.method === 'POST') return new Response(JSON.stringify({ success: true }));
        if (String(url).includes('?search=')) {
          const subject = new URL(String(url)).searchParams.get('search');
          return new Response(JSON.stringify([{ id: 99, subject }]));
        }
        return new Response(JSON.stringify(report));
      });
      await expect(f.service.check('<p>Update</p>')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
  });
  it('preserves a successful empty analysis as a report, without claiming client screenshots', async () => {
    const f = fixture();
    f.fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') return new Response(JSON.stringify({ success: true }));
      if (String(url).includes('?search=')) {
        const subject = new URL(String(url)).searchParams.get('search');
        return new Response(JSON.stringify([{ id: 99, subject }]));
      }
      return new Response(JSON.stringify({ status: 'success', errors: [] }));
    });
    expect(await f.service.check('<p>Update</p>')).toEqual({
      provider: 'Mailtrap',
      issues: [],
      report: { status: 'success', errors: [] },
    });
  });
});
