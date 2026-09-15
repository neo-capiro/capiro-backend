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
  keepAlive: jest.Mock;
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
    keepAlive: jest.fn(),
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
    jest.advanceTimersByTime(800);
    first.emit('close', { code: 1011, reason: 'reset' });
    expect(cb.onReconnecting).toHaveBeenCalledWith(1);

    manager.sendAudio(Buffer.alloc(16_000)); // buffered source timeline 1000-1500 ms
    jest.advanceTimersByTime(500);
    expect(live).toHaveBeenCalledTimes(2);
    second.emit('open');
    expect(second.send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(400);
    expect(second.send).toHaveBeenCalledTimes(5);

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

  it('keeps a silent socket alive across four hours and cleans up its timers on stop', () => {
    const connection = fakeConnection();
    const live = jest.fn(() => connection);
    createClientMock.mockReturnValue({ listen: { live } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb);
    manager.start();
    connection.emit('open');

    jest.advanceTimersByTime(4 * 60 * 60_000);
    expect(connection.keepAlive).toHaveBeenCalledTimes(4_800);
    expect(live).toHaveBeenCalledTimes(1);
    expect(manager.sendAudio(Buffer.alloc(3_200))).toBe(true);
    expect(cb.onError).not.toHaveBeenCalled();
    manager.stop();
    jest.advanceTimersByTime(30_000);
    expect(connection.keepAlive).toHaveBeenCalledTimes(4_800);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('paces backlog replay and prevents fresh PCM from overtaking buffered audio', () => {
    const connection = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => connection) } } as never);
    const manager = new ServerDeepgramStreamManager('key', callbacks());
    manager.start();
    manager.sendAudio(Buffer.alloc(32_000, 1));
    connection.emit('open');
    manager.sendAudio(Buffer.alloc(3_200, 2));
    expect(connection.send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(719);
    expect(connection.send).toHaveBeenCalledTimes(9);
    expect(manager.bufferedDurationMs).toBe(200);
    jest.advanceTimersByTime(81);
    expect(connection.send).toHaveBeenCalledTimes(11);
    expect(Buffer.from(connection.send.mock.calls[9]![0]).every((value) => value === 1)).toBe(true);
    expect(Buffer.from(connection.send.mock.calls[10]![0]).every((value) => value === 2)).toBe(true);
    expect(manager.bufferedDurationMs).toBe(0);
    manager.stop();
  });

  it('drains buffered PCM and still accepts the final transcript during CloseStream', async () => {
    const connection = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => connection) } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb);
    manager.start();
    connection.emit('open');
    manager.sendAudio(Buffer.alloc(32_000));
    connection.requestClose.mockImplementation(() => {
      connection.emit('transcript', {
        is_final: true, start: 0, duration: 1,
        channel: { alternatives: [{ transcript: 'closing testimony' }] },
      });
      connection.emit('close', { code: 1000 });
    });
    const stopped = manager.stopAndWait(5_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(connection.send).toHaveBeenCalledTimes(10);
    expect(cb.onFinal).toHaveBeenCalledWith(expect.objectContaining({ text: 'closing testimony' }));
    expect(cb.onGap).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('splits a mixed-speaker final into contiguous runs with the base applied exactly once', () => {
    const connection = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => connection) } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb, { initialTimelineMs: 1_000 });

    manager.start();
    connection.emit('open'); // connectionBaseMs = source cursor = 1000
    connection.emit('transcript', {
      is_final: true,
      start: 0,
      duration: 3.5,
      channel: {
        alternatives: [
          {
            transcript: 'Hello there. Yes indeed. Back to me.',
            confidence: 0.9,
            words: [
              { word: 'Hello', punctuated_word: 'Hello', start: 0, end: 0.5, speaker: 0 },
              { word: 'there', punctuated_word: 'there.', start: 0.5, end: 1.0, speaker: 0 },
              { word: 'Yes', punctuated_word: 'Yes', start: 1.2, end: 1.6, speaker: 1 },
              { word: 'indeed', punctuated_word: 'indeed.', start: 1.6, end: 2.0, speaker: 1 },
              { word: 'Back', punctuated_word: 'Back', start: 2.4, end: 2.8, speaker: 0 },
              { word: 'to', punctuated_word: 'to', start: 2.8, end: 3.0, speaker: 0 },
              { word: 'me', punctuated_word: 'me.', start: 3.0, end: 3.5, speaker: 0 },
            ],
          },
        ],
      },
    });

    expect((cb.onFinal as jest.Mock).mock.calls.map(([segment]) => segment)).toEqual([
      { startMs: 1_000, endMs: 2_000, text: 'Hello there.', speakerLabel: '0', confidence: 0.9 },
      { startMs: 2_200, endMs: 3_000, text: 'Yes indeed.', speakerLabel: '1', confidence: 0.9 },
      { startMs: 3_400, endMs: 4_500, text: 'Back to me.', speakerLabel: '0', confidence: 0.9 },
    ]);
  });

  it('produces identical ranges when an identical final is replayed and keeps an unsplittable frame whole + unknown', () => {
    const connection = fakeConnection();
    createClientMock.mockReturnValue({ listen: { live: jest.fn(() => connection) } } as never);
    const cb = callbacks();
    const manager = new ServerDeepgramStreamManager('key', cb);
    manager.start();
    connection.emit('open');

    const final = {
      is_final: true,
      start: 10,
      duration: 2,
      channel: {
        alternatives: [
          {
            transcript: 'one two three four',
            confidence: 0.5,
            words: [
              { word: 'one', start: 10.0, end: 10.4, speaker: 0 },
              { word: 'two', start: 10.4, end: 10.8, speaker: 0 },
              { word: 'three', start: 11.0, end: 11.5, speaker: 1 },
              { word: 'four', start: 11.5, end: 12.0, speaker: 1 },
            ],
          },
        ],
      },
    };
    connection.emit('transcript', final);
    const firstReplay = (cb.onFinal as jest.Mock).mock.calls.map(([segment]) => segment);
    connection.emit('transcript', final);
    const secondReplay = (cb.onFinal as jest.Mock).mock.calls
      .slice(firstReplay.length)
      .map(([segment]) => segment);
    expect(secondReplay).toEqual(firstReplay);
    expect(firstReplay.map((s) => [s.startMs, s.endMs, s.speakerLabel])).toEqual([
      [10_000, 10_800, '0'],
      [11_000, 12_000, '1'],
    ]);

    // Interim with mixed speakers must not wear the first word's label.
    connection.emit('transcript', {
      is_final: false,
      start: 20,
      duration: 1,
      channel: {
        alternatives: [
          {
            transcript: 'mixed interim',
            words: [
              { word: 'mixed', start: 20, end: 20.5, speaker: 0 },
              { word: 'interim', start: 20.5, end: 21.0, speaker: 1 },
            ],
          },
        ],
      },
    });
    expect(cb.onInterim).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'mixed interim', speakerLabel: undefined }),
    );

    // Unsplittable final (out-of-order word timing): complete frame, unknown.
    connection.emit('transcript', {
      is_final: true,
      start: 30,
      duration: 2.5,
      channel: {
        alternatives: [
          {
            transcript: 'alpha beta gamma',
            words: [
              { word: 'alpha', start: 30, end: 32.0, speaker: 0 },
              { word: 'beta', start: 30.5, end: 31.0, speaker: 1 },
              { word: 'gamma', start: 32.0, end: 32.5, speaker: 1 },
            ],
          },
        ],
      },
    });
    const last = (cb.onFinal as jest.Mock).mock.calls.at(-1)![0];
    expect(last).toMatchObject({
      startMs: 30_000,
      endMs: 32_500,
      text: 'alpha beta gamma',
      speakerLabel: undefined,
    });
  });

});
