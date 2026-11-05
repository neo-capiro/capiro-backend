import { createHash } from 'node:crypto';
import {
  fetchStatePublisherDocument,
  publisherDestination,
  publisherRetryDelay,
  publisherCooldown,
} from './state-publisher-document.js';
import { withGuardedWebResponse, readBodyWithSizeLimit } from '../meri/hardenedWebTransport.js';
jest.mock('../meri/hardenedWebTransport.js', () => ({
  withGuardedWebResponse: jest.fn(),
  readBodyWithSizeLimit: jest.fn(),
}));
const bytes = Buffer.from('%PDF-synthetic immutable version');
const stub = {
  kind: 'text' as const,
  providerId: 23,
  providerHash: createHash('md5').update(bytes).digest('hex'),
  size: bytes.length,
  mime: 'application/pdf',
  stateUrl: 'https://www.flsenate.gov/Session/Bill/2026/1/BillText/Filed/PDF',
  date: '2026-01-01',
  versionType: 'Introduced',
};
let response: Response;
beforeEach(() => {
  jest.clearAllMocks();
  response = new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  (readBodyWithSizeLimit as jest.Mock).mockResolvedValue(bytes);
  (withGuardedWebResponse as jest.Mock).mockImplementation(async (url, consume, options) => {
    options.validateDestination(new URL(url));
    return consume(response, url, {});
  });
});
test('accepts only exact frozen primary bytes and keeps original citation/version', async () => {
  const doc = await fetchStatePublisherDocument('FL', 11, stub);
  expect(doc).toMatchObject({
    bill_id: 11,
    doc_id: 23,
    text_hash: stub.providerHash,
    text_size: bytes.length,
    type: 'Introduced',
    state_link: stub.stateUrl,
    acquisition: { source: 'publisher', url: stub.stateUrl },
  });
  expect(Buffer.from(doc.doc, 'base64')).toEqual(bytes);
  expect(readBodyWithSizeLimit).toHaveBeenCalledWith(response, bytes.length, expect.anything());
});
test('preserves alternate-format provenance with its own immutable bytes', async () => {
  const format = {
    role: 'alternate' as const,
    primaryProviderHash: 'a'.repeat(32),
    receiptId: 'b'.repeat(64),
    archiveHash: 'c'.repeat(64),
  };
  const doc = await fetchStatePublisherDocument('FL', 11, { ...stub, format });
  expect(doc.format).toEqual(format);
  expect(doc.text_hash).toBe(stub.providerHash);
  expect(doc.mime).toBe('application/pdf');
});
test.each(['size', 'hash', 'mime', 'signature'])(
  'rejects a publisher %s mismatch',
  async (change) => {
    let expected = { ...stub };
    if (change === 'size')
      (readBodyWithSizeLimit as jest.Mock).mockResolvedValue(Buffer.from('short'));
    if (change === 'hash') expected.providerHash = '0'.repeat(32);
    if (change === 'mime')
      response = new Response(bytes, { headers: { 'content-type': 'text/html' } });
    if (change === 'signature') {
      const invalid = Buffer.from('not a PDF');
      expected = {
        ...expected,
        size: invalid.length,
        providerHash: createHash('md5').update(invalid).digest('hex'),
      };
      (readBodyWithSizeLimit as jest.Mock).mockResolvedValue(invalid);
    }
    await expect(fetchStatePublisherDocument('FL', 11, expected)).rejects.toThrow(/MISMATCH/);
  },
);
test('same URL with a different historical provider hash is not credited', async () => {
  await expect(
    fetchStatePublisherDocument('FL', 11, {
      ...stub,
      providerId: 24,
      providerHash: 'b'.repeat(32),
    }),
  ).rejects.toThrow('DOCUMENT_PROVIDER_HASH_MISMATCH');
});
test.each([
  'https://www.flsenate.gov.attacker.test/document',
  'https://127.0.0.1/a',
  'https://www.flsenate.gov:444/a',
  'https://user:pass@www.flsenate.gov/a',
])('rejects unqualified destination %s', async (url) => {
  await expect(fetchStatePublisherDocument('FL', 11, { ...stub, stateUrl: url })).rejects.toThrow(
    'PUBLISHER_HOST_UNQUALIFIED',
  );
  expect(withGuardedWebResponse).not.toHaveBeenCalled();
});
test('fragment-only historical selector and incomplete primary metadata refuse before network', async () => {
  await expect(
    fetchStatePublisherDocument('FL', 11, { ...stub, stateUrl: stub.stateUrl + '#older' }),
  ).rejects.toThrow('HISTORICAL_URL');
  await expect(fetchStatePublisherDocument('FL', 11, { ...stub, size: undefined })).rejects.toThrow(
    'METADATA_UNQUALIFIED',
  );
  expect(withGuardedWebResponse).not.toHaveBeenCalled();
});
test('redirect policy rejects another publisher and HTTPS downgrade before connection', () => {
  expect(() => publisherDestination('FL', new URL('https://leg.colorado.gov/doc'))).toThrow(
    'HOST_UNQUALIFIED',
  );
  expect(() => publisherDestination('FL', new URL('http://www.flsenate.gov/doc'))).toThrow(
    'HOST_UNQUALIFIED',
  );
});
test('429 retains Retry-After and never retries/circumvents the publisher', async () => {
  response = new Response('', { status: 429, headers: { 'retry-after': '120' } });
  await expect(fetchStatePublisherDocument('FL', 11, stub)).rejects.toMatchObject({
    message: 'PUBLISHER_RETRY_AFTER',
    retryAfterMs: 120000,
  });
  expect(withGuardedWebResponse).toHaveBeenCalledTimes(1);
  expect(readBodyWithSizeLimit).not.toHaveBeenCalled();
});
test('403 is explicit unavailable and does not try other identities or content extraction', async () => {
  response = new Response('blocked', { status: 403 });
  await expect(fetchStatePublisherDocument('FL', 11, stub)).rejects.toThrow('PUBLISHER_HTTP_403');
  expect(readBodyWithSizeLimit).not.toHaveBeenCalled();
});
test('Retry-After dates and malformed values remain bounded', () => {
  expect(publisherRetryDelay('Thu, 01 Jan 1970 00:02:00 GMT', 0)).toBe(120000);
  expect(publisherRetryDelay('invalid')).toBe(60000);
  expect(publisherRetryDelay('999999999')).toBe(86400000);
  expect(publisherRetryDelay('0')).toBe(1000);
  expect(publisherRetryDelay(null)).toBe(60000);
});

test.each([429, 503])(
  'persists an actual HTTP %s host hold before returning explicit backoff',
  async (status) => {
    response = new Response('', { status, headers: { 'retry-after': '120' } });
    const cooldown = { remaining: jest.fn(async () => 0), hold: jest.fn(async () => 180000) };
    await expect(fetchStatePublisherDocument('FL', 11, stub, cooldown)).rejects.toMatchObject({
      message: 'PUBLISHER_RETRY_AFTER',
      retryAfterMs: 180000,
      host: 'www.flsenate.gov',
      httpStatus: status,
    });
    expect(cooldown.hold).toHaveBeenCalledWith('www.flsenate.gov', 120000, status);
    expect(readBodyWithSizeLimit).not.toHaveBeenCalled();
  },
);

test('a durable hold suppresses a fresh host before a response and another host remains independent', async () => {
  const consume = jest.fn();
  (withGuardedWebResponse as jest.Mock).mockImplementation(async (url, callback, options) => {
    const destination = new URL(url);
    options.validateDestination(destination);
    await options.beforeRequest(destination);
    consume();
    return callback(response, url, {});
  });
  const cooldown = {
    remaining: jest.fn(async (host: string) => (host === 'www.flhouse.gov' ? 120000 : 0)),
    hold: jest.fn(async () => 0),
  };
  await expect(
    fetchStatePublisherDocument(
      'FL',
      11,
      { ...stub, stateUrl: 'https://www.flhouse.gov/file.pdf' },
      cooldown,
    ),
  ).rejects.toMatchObject({
    message: 'PUBLISHER_COOLDOWN_ACTIVE',
    retryAfterMs: 120000,
    host: 'www.flhouse.gov',
  });
  expect(consume).not.toHaveBeenCalled();
  expect(cooldown.hold).not.toHaveBeenCalled();
  await expect(
    fetchStatePublisherDocument(
      'AR',
      11,
      { ...stub, stateUrl: 'https://www.arkleg.state.ar.us/file.pdf' },
      cooldown,
    ),
  ).resolves.toMatchObject({ doc_id: 23 });
  expect(consume).toHaveBeenCalledTimes(1);
});

test('checkpoint failures fail closed with a distinct operational error', async () => {
  const db: any = {
    $queryRawUnsafe: jest.fn(async () => {
      throw Error('synthetic database failure');
    }),
  };
  const cooldown = publisherCooldown(db);
  await expect(cooldown.remaining('www.flsenate.gov')).rejects.toThrow(
    'PUBLISHER_COOLDOWN_STATE_FAILED',
  );
  await expect(cooldown.hold('www.flsenate.gov', 60000, 429)).rejects.toThrow(
    'PUBLISHER_COOLDOWN_STATE_FAILED',
  );
});

test.each(['read', 'hold'])(
  'a transport deadline during durable cooldown %s cannot become a provider fallback',
  async (stage) => {
    let settle!: (remaining: number) => void;
    const pendingState = new Promise<number>((resolve) => {
      settle = resolve;
    });
    const never = () => pendingState;
    const cooldown = { remaining: stage === 'read' ? never : async () => 0, hold: never };
    response = new Response('', { status: 503, headers: { 'retry-after': '120' } });
    (withGuardedWebResponse as jest.Mock).mockImplementation(async (url, consume, options) => {
      const pending =
        stage === 'read' ? options.beforeRequest(new URL(url)) : consume(response, url, {});
      void pending.catch(() => {});
      await Promise.resolve();
      await Promise.resolve();
      throw Error('synthetic transport deadline');
    });
    try {
      await expect(
        fetchStatePublisherDocument(
          'FL',
          11,
          { ...stub, stateUrl: 'https://www.flhouse.gov/file.pdf' },
          cooldown,
        ),
      ).rejects.toMatchObject({
        message: 'PUBLISHER_COOLDOWN_STATE_FAILED',
        host: 'www.flhouse.gov',
      });
    } finally {
      settle(0);
      await pendingState;
    }
  },
);

test('successive request starts to the same publisher are paced at least one second apart', async () => {
  jest.useFakeTimers();
  try {
    await fetchStatePublisherDocument('AL', 11, {
      ...stub,
      stateUrl: 'https://alison.legislature.state.al.us/file.pdf',
    });
    const options = (withGuardedWebResponse as jest.Mock).mock.calls.at(-1)[2];
    const url = new URL('https://alison.legislature.state.al.us/file.pdf');
    await options.beforeRequest(url);
    let second = false;
    const pending = options.beforeRequest(url).then(() => {
      second = true;
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(second).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(second).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
