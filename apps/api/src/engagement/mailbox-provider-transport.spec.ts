import { GoogleSyncService } from './google/google-sync.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { AmbiguousMailSendError } from './mail-send-result.js';
import {
  MAILBOX_CALL_TIMEOUT_MS,
  mailboxMsalNetwork,
  MailboxDeadlineError,
} from './mailbox-provider-transport.js';

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test.each(['google', 'graph', 'msal'] as const)(
  '%s aborts a never-resolving provider request',
  async (kind) => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise(() => {});
    });
    const google = Object.create(GoogleSyncService.prototype) as any;
    const graph = Object.create(MicrosoftGraphSyncService.prototype) as any;
    const result =
      kind === 'google'
        ? google.googleGet('https://example.invalid', 'synthetic')
        : kind === 'graph'
          ? graph.graphFetch('GET', '/me/messages', 'synthetic')
          : mailboxMsalNetwork.sendPostRequestAsync('https://example.invalid', {
              body: 'synthetic',
            });
    const rejected = expect(result).rejects.toBeInstanceOf(MailboxDeadlineError);
    await jest.advanceTimersByTimeAsync(MAILBOX_CALL_TIMEOUT_MS);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('response body consumption has the same request deadline', async () => {
  jest.useFakeTimers();
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
      headers: new Headers(),
    } as unknown as Response);
  const service = Object.create(GoogleSyncService.prototype) as any;
  const rejected = expect(
    service.googleGet('https://example.invalid', 'synthetic'),
  ).rejects.toBeInstanceOf(MailboxDeadlineError);
  await jest.advanceTimersByTimeAsync(MAILBOX_CALL_TIMEOUT_MS);
  await rejected;
});

test('existing Graph send timeout remains unknown and is dispatched once', async () => {
  jest.useFakeTimers();
  const service = Object.create(MicrosoftGraphSyncService.prototype) as any;
  service.assertConnectionAccess = async () => {};
  service.loadConnection = async () => ({ token: {} });
  service.getValidAccessToken = async () => 'synthetic';
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) =>
      String(url).endsWith('/send')
        ? new Promise(() => {})
        : new Response(JSON.stringify({ id: 'draft' }), { status: 201 }),
    );
  const result = service.sendMail({ tenantId: 'tenant', userId: 'actor' }, 'connection', {
    subject: 'Synthetic',
    body: 'Synthetic',
    toRecipients: [],
  });
  const rejected = expect(result).rejects.toBeInstanceOf(AmbiguousMailSendError);
  await jest.advanceTimersByTimeAsync(MAILBOX_CALL_TIMEOUT_MS);
  await rejected;
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/send'))).toHaveLength(1);
});
