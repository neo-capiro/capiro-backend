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
import {
  ServerDeepgramStreamManager,
  type ServerDeepgramStreamCallbacks,
} from './server-deepgram-stream.manager.js';

interface FakeConnection {
  on: jest.Mock;
  send: jest.Mock;
  requestClose: jest.Mock;
  emit: (event: string, payload?: unknown) => void;
}

function fakeConnection(): FakeConnection {
  const handlers = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    on: jest.fn((event: string, callback: (payload?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), callback]);
    }),
    send: jest.fn(),
    requestClose: jest.fn(),
    emit: (event: string, payload?: unknown) => {
      for (const callback of handlers.get(event) ?? []) callback(payload);
    },
  };
}

function callbacks(): ServerDeepgramStreamCallbacks & Record<string, jest.Mock> {
  return {
    onOpen: jest.fn(),
    onInterim: jest.fn(),
    onFinal: jest.fn(),
    onError: jest.fn(),
    onReconnecting: jest.fn(),
    onGap: jest.fn(),
  };
}

const createClientMock = jest.mocked(createClient);

describe('ServerDeepgramStreamManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens Deepgram for headerless linear16 PCM and flushes pre-open audio', () => {
    const connection = fakeConnection();
    const live = jest.fn(() => connection);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb);

    manager.start();
    expect(manager.sendAudio(Buffer.alloc(3_200))).toBe(true); // 100 ms at 16 kHz mono s16le
    expect(connection.send).not.toHaveBeenCalled();

    connection.emit('open');

    expect(live).toHaveBeenCalledWith(
      expect.objectContaining({ encoding: 'linear16', sample_rate: 16_000, channels: 1 }),
    );
    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(manager.bufferedDurationMs).toBe(0);
  });

  it('buffers through a reconnect and keeps transcript timestamps on the global timeline', () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const live = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, {
      reconnectBaseDelayMs: 500,
      reconnectMaxDelayMs: 500,
    });

    manager.start();
    first.emit('open');
    manager.sendAudio(Buffer.alloc(32_000)); // source timeline 0-1000 ms
    first.emit('close', { code: 1011, reason: 'reset' });
    expect(cb.onReconnecting).toHaveBeenCalledWith(1);

    manager.sendAudio(Buffer.alloc(16_000)); // buffered source timeline 1000-1500 ms
    jest.advanceTimersByTime(500);
    expect(live).toHaveBeenCalledTimes(2);
    second.emit('open');
    expect(second.send).toHaveBeenCalledTimes(1);

    second.emit('transcript', {
      is_final: true,
      start: 0,
      duration: 0.5,
      channel: { alternatives: [{ transcript: 'continued testimony', confidence: 0.9 }] },
    });

    expect(cb.onFinal).toHaveBeenCalledWith(
      expect.objectContaining({ startMs: 1_000, endMs: 1_500, text: 'continued testimony' }),
    );
    expect(cb.onGap).not.toHaveBeenCalled();
  });

  it('fails visibly rather than silently dropping PCM when the reconnect buffer overflows', () => {
    const connection = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => connection) } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, { bufferDurationMs: 1_000 });

    manager.start();
    expect(manager.sendAudio(Buffer.alloc(40_000))).toBe(false);
    expect(cb.onGap).toHaveBeenCalledWith(
      expect.objectContaining({ startMs: 0, reason: 'BUFFER_OVERFLOW' }),
    );
    expect(cb.onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('buffers the exact PCM chunk that failed to send and retries it on the replacement socket', () => {
    const first = fakeConnection();
    const second = fakeConnection();
    first.send.mockImplementationOnce(() => {
      throw new Error('socket reset during send');
    });
    const live = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, {
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 100,
    });

    manager.start();
    first.emit('open');
    expect(manager.sendAudio(Buffer.alloc(3_200))).toBe(true);
    expect(manager.bufferedDurationMs).toBe(100);
    expect(first.requestClose).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100);
    second.emit('open');
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(manager.bufferedDurationMs).toBe(0);
    expect(cb.onGap).not.toHaveBeenCalled();
  });

  it('ignores late events from a replaced Deepgram socket', () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const live = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, {
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 100,
    });

    manager.start();
    first.emit('open');
    first.emit('close', { code: 1011 });
    jest.advanceTimersByTime(100);
    second.emit('open');

    first.emit('close', { code: 1011, reason: 'late duplicate' });
    first.emit('error', new Error('late error'));
    jest.advanceTimersByTime(1_000);

    expect(live).toHaveBeenCalledTimes(2);
    expect(cb.onReconnecting).toHaveBeenCalledTimes(1);
  });

  it('reconnects on an Error event even when the SDK never emits Close', () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const live = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, {
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 100,
    });

    manager.start();
    first.emit('open');
    first.emit('error', new Error('upstream websocket error'));
    expect(first.requestClose).toHaveBeenCalledTimes(1);
    expect(cb.onReconnecting).toHaveBeenCalledWith(1);

    jest.advanceTimersByTime(100);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it('surfaces all buffered PCM as a gap when the reconnect budget is exhausted', () => {
    const first = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => first) } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, { maxReconnects: 0 });

    manager.start();
    expect(manager.sendAudio(Buffer.alloc(3_200))).toBe(true);
    first.emit('close', { code: 1011 });

    expect(cb.onGap).toHaveBeenCalledWith({
      startMs: 0,
      endMs: 100,
      reason: 'DEEPGRAM_DISCONNECT',
    });
    expect(cb.onError).toHaveBeenCalledTimes(1);
  });

});
