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
  keepAlive: jest.Mock;
  requestClose: jest.Mock;
  disconnect: jest.Mock;
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
    keepAlive: jest.fn(),
    requestClose: jest.fn(),
    disconnect: jest.fn(),
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
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
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
      const cb = callbacks();
      const manager = new DeepgramStreamManager('key', cb);
      manager.start();
      conn.emit('open');

      const stopping = manager.stopAndWait(25);
      const final = { is_final: true, start: 0, duration: 1,
        channel: { alternatives: [{ transcript: 'final words' }] } };
      conn.emit('transcript', final);
      await jest.advanceTimersByTimeAsync(25);
      await stopping;
      conn.emit('transcript', final);

      expect((manager as any).closeWaiters.size).toBe(0);
      expect(conn.disconnect).toHaveBeenCalledTimes(1);
      expect(cb.onFinal).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an idle four-hour hearing open without reconnecting or changing its timeline', async () => {
    const conn = fakeConnection();
    const live = jest.fn(() => conn);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);
    manager.start();
    conn.emit('open');
    expect(manager.sendAudio(Buffer.from('webm-header'))).toBe(true);

    await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
    conn.emit('transcript', {
      is_final: true,
      start: 14_400,
      duration: 2,
      channel: { alternatives: [{ transcript: 'The hearing will resume.' }] },
    });

    expect(conn.keepAlive).toHaveBeenCalledTimes(3_600);
    expect(live).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onFinal).toHaveBeenCalledWith(expect.objectContaining({
      startMs: 14_400_000,
      endMs: 14_402_000,
      text: 'The hearing will resume.',
    }));
    manager.stop();
    await jest.advanceTimersByTimeAsync(12_000);
    expect(conn.keepAlive).toHaveBeenCalledTimes(3_600);
  });

  it('stops keepalive and fails once when the provider becomes unavailable', async () => {
    const conn = fakeConnection();
    conn.keepAlive.mockImplementation(() => { throw new Error('socket unavailable'); });
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);
    manager.start();
    conn.emit('open');

    await jest.advanceTimersByTimeAsync(12_000);
    expect(conn.keepAlive).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(manager.sendAudio(Buffer.from('late-audio'))).toBe(false);
  });

  it('does not resurrect a socket that opens after capture was stopped', async () => {
    const conn = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);
    manager.start();
    manager.stop();
    conn.emit('open');

    await jest.advanceTimersByTimeAsync(12_000);
    expect(cb.onOpen).not.toHaveBeenCalled();
    expect(conn.keepAlive).not.toHaveBeenCalled();
    expect(conn.requestClose).toHaveBeenCalledTimes(2);
    expect(manager.isOpen).toBe(false);
  });

  it('splits a mixed-speaker final into ordered runs without adding any timeline base', () => {
    const conn = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);
    manager.start();
    conn.emit('open');

    conn.emit('transcript', {
      is_final: true,
      start: 100,
      duration: 3.5,
      channel: {
        alternatives: [
          {
            transcript: 'Hello there. Yes indeed. Back to me.',
            confidence: 0.9,
            words: [
              { word: 'Hello', punctuated_word: 'Hello', start: 100, end: 100.5, speaker: 0 },
              { word: 'there', punctuated_word: 'there.', start: 100.5, end: 101, speaker: 0 },
              { word: 'Yes', punctuated_word: 'Yes', start: 101.2, end: 101.6, speaker: 1 },
              { word: 'indeed', punctuated_word: 'indeed.', start: 101.6, end: 102, speaker: 1 },
              { word: 'Back', punctuated_word: 'Back', start: 102.4, end: 102.8, speaker: 0 },
              { word: 'to', punctuated_word: 'to', start: 102.8, end: 103, speaker: 0 },
              { word: 'me', punctuated_word: 'me.', start: 103, end: 103.5, speaker: 0 },
            ],
          },
        ],
      },
    });

    // Ranges are exactly the word-derived milliseconds — the gateway's
    // persisted timelineOffsetMs is applied downstream, not here.
    expect((cb.onFinal as jest.Mock).mock.calls.map(([segment]) => segment)).toEqual([
      { startMs: 100_000, endMs: 101_000, text: 'Hello there.', speakerLabel: '0', confidence: 0.9 },
      { startMs: 101_200, endMs: 102_000, text: 'Yes indeed.', speakerLabel: '1', confidence: 0.9 },
      { startMs: 102_400, endMs: 103_500, text: 'Back to me.', speakerLabel: '0', confidence: 0.9 },
    ]);
  });

  it('never labels a mixed interim with the first word speaker and retains split runs on graceful flush', async () => {
    const conn = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const cb = callbacks();
    const manager = new DeepgramStreamManager('key', cb);
    manager.start();
    conn.emit('open');

    conn.emit('transcript', {
      is_final: false,
      start: 0,
      duration: 1,
      channel: {
        alternatives: [
          {
            transcript: 'interim mix',
            words: [
              { word: 'interim', start: 0, end: 0.5, speaker: 0 },
              { word: 'mix', start: 0.5, end: 1.0, speaker: 1 },
            ],
          },
        ],
      },
    });
    expect(cb.onInterim).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'interim mix', speakerLabel: undefined }),
    );
    expect(cb.onFinal).not.toHaveBeenCalled();

    conn.requestClose.mockImplementation(() => {
      conn.emit('transcript', {
        is_final: true,
        start: 2,
        duration: 2,
        channel: {
          alternatives: [
            {
              transcript: 'last words here',
              confidence: 0.7,
              words: [
                { word: 'last', start: 2.0, end: 2.5, speaker: 0 },
                { word: 'words', start: 2.5, end: 3.0, speaker: 1 },
                { word: 'here', start: 3.0, end: 4.0, speaker: 1 },
              ],
            },
          ],
        },
      });
      conn.emit('close', { code: 1000 });
    });
    await manager.stopAndWait(5_000);

    expect((cb.onFinal as jest.Mock).mock.calls.map(([segment]) => segment)).toEqual([
      { startMs: 2_000, endMs: 2_500, text: 'last', speakerLabel: '0', confidence: 0.7 },
      { startMs: 2_500, endMs: 4_000, text: 'words here', speakerLabel: '1', confidence: 0.7 },
    ]);
  });

  it('does not wait for another close after the provider already disconnected', async () => {
    const conn = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => conn) } } as never);
    const manager = new DeepgramStreamManager('key', callbacks());
    manager.start();
    conn.emit('open');
    conn.emit('close', { code: 1011 });

    await manager.stopAndWait();
    expect(conn.requestClose).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
