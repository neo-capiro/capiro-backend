jest.mock('@deepgram/sdk', () => ({
  createClient: jest.fn(),
  LiveTranscriptionEvents: {
    Open: 'open',
    Metadata: 'metadata',
    Transcript: 'transcript',
    Error: 'error',
    Close: 'close',
  },
}));

import { createClient } from '@deepgram/sdk';
import { DeepgramStreamManager, type DeepgramStreamCallbacks } from './deepgram-stream.manager.js';

interface FakeConnection {
  on: jest.Mock;
  send: jest.Mock;
  requestClose: jest.Mock;
  emit: (event: string, payload?: unknown) => void;
}

function fakeConnection(): FakeConnection {
  const handlers = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    on: jest.fn((event: string, cb: (payload?: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    send: jest.fn(),
    requestClose: jest.fn(),
    emit: (event: string, payload?: unknown) => {
      for (const cb of handlers.get(event) ?? []) cb(payload);
    },
  };
}

function callbacks(): DeepgramStreamCallbacks & {
  onOpen: jest.Mock;
  onError: jest.Mock;
  onInterim: jest.Mock;
  onFinal: jest.Mock;
  onReconnecting: jest.Mock;
} {
  return {
    onOpen: jest.fn(),
    onError: jest.fn(),
    onInterim: jest.fn(),
    onFinal: jest.fn(),
    onReconnecting: jest.fn(),
  };
}

const createClientMock = jest.mocked(createClient);

describe('DeepgramStreamManager browser WebM safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets Deepgram auto-detect the WebM container instead of claiming raw Opus', () => {
    const conn = fakeConnection();
    const live = jest.fn((_options: Record<string, unknown>) => conn);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);

    manager.start();

    expect(live).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'nova-3', interim_results: true, diarize: true }),
    );
    const options = live.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('encoding');
    expect(options).not.toHaveProperty('sample_rate');
  });

  it('does not accept browser bytes until the Deepgram socket is open', () => {
    const conn = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const manager = new DeepgramStreamManager('key', callbacks());
    manager.start();

    expect(manager.sendAudio(Buffer.from('before-open'))).toBe(false);
    expect(conn.send).not.toHaveBeenCalled();

    conn.emit('open');
    expect(manager.sendAudio(Buffer.from('after-open'))).toBe(true);
    expect(conn.send).toHaveBeenCalledTimes(1);
  });

  it('fails once on an unexpected close and never opens a second mid-container socket', () => {
    const conn = fakeConnection();
    const live = jest.fn(() => conn);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);
    manager.start();
    conn.emit('open');

    conn.emit('close', { code: 1011, reason: 'upstream reset' });
    conn.emit('error', new Error('duplicate terminal event'));

    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError.mock.calls[0]?.[0].message).toMatch(/Restart transcription/i);
    expect(cb.onReconnecting).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('waits for Deepgram close during graceful finalization and removes its waiter', async () => {
    const conn = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const manager = new DeepgramStreamManager('key', callbacks());
    manager.start();
    conn.emit('open');

    const stopping = manager.stopAndWait(5_000);
    expect(conn.requestClose).toHaveBeenCalledTimes(1);
    expect((manager as any).closeWaiters.size).toBe(1);

    conn.emit('close', { code: 1000, reason: 'normal' });
    await stopping;

    expect((manager as any).closeWaiters.size).toBe(0);
  });

  it('times out a missing close event without retaining a callback', async () => {
    jest.useFakeTimers();
    try {
      const conn = fakeConnection();
      createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
      const manager = new DeepgramStreamManager('key', callbacks());
      manager.start();
      conn.emit('open');

      const stopping = manager.stopAndWait(25);
      await jest.advanceTimersByTimeAsync(25);
      await stopping;

      expect((manager as any).closeWaiters.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
