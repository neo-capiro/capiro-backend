import { afterEach, describe, expect, it, vi } from 'vitest';
import { HearingRecordingTransport } from './hearing-recording-transport.js';
import { Blob } from 'node:buffer';

function connection() {
  const frames: ArrayBuffer[] = [];
  const socket = {
    readyState: 1,
    send: vi.fn((frame: ArrayBuffer) => frames.push(frame)),
  } as unknown as WebSocket;
  const saved = vi.fn(),
    transport = new HearingRecordingTransport(socket, 'epoch-1', saved);
  return { socket, frames, saved, transport };
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
afterEach(() => vi.useRealTimers());
describe('durable browser transport', () => {
  it('does not finish a queued part until this epoch and sequence are acknowledged', async () => {
    const { transport, frames, saved } = connection();
    let done = false;
    const drain = transport
      .enqueue(new Blob(['audio']) as unknown as globalThis.Blob, 1000)
      .then(() => {
        done = true;
      });
    await tick();
    expect(frames).toHaveLength(1);
    expect(done).toBe(false);
    expect(transport.finalSequence).toBe(-1);
    transport.acknowledge({
      epochId: 'old-epoch',
      sequence: 0,
      durableBytes: 5,
      durableEndMs: 1000,
    });
    expect(saved).not.toHaveBeenCalled();
    transport.acknowledge({ epochId: 'epoch-1', sequence: 0, durableBytes: 5, durableEndMs: 1000 });
    await drain;
    expect(done).toBe(true);
    expect(transport.finalSequence).toBe(0);
    expect(transport.backlogBytes).toBe(0);
  });

  it('splits delayed blobs without claiming unsaved time or changing container bytes', async () => {
    const { transport, frames } = connection();
    const bytes = new Uint8Array(300 * 1024).fill(7);
    const drain = transport.enqueue(new Blob([bytes]) as unknown as globalThis.Blob, 8000);
    await tick();
    expect(new DataView(frames[0]!).getFloat64(8)).toBe(0);
    transport.acknowledge({
      epochId: 'epoch-1',
      sequence: 0,
      durableBytes: 250 * 1024,
      durableEndMs: 0,
    });
    await tick();
    expect(new DataView(frames[1]!).getFloat64(8)).toBe(8000);
    expect(new Uint8Array(frames[1]!, 16).every((byte) => byte === 7)).toBe(true);
    transport.acknowledge({
      epochId: 'epoch-1',
      sequence: 1,
      durableBytes: bytes.length,
      durableEndMs: 8000,
    });
    await drain;
  });

  it('retries the identical sequence and bytes when a save acknowledgement is lost', async () => {
    const { transport, frames } = connection();
    const drain = transport.enqueue(new Blob(['audio']) as unknown as globalThis.Blob, 1000);
    await tick();
    vi.useFakeTimers();
    // The first real timer is cleared on stop; test retries under fake time by
    // starting a second transport entirely under that clock.
    transport.stop();
    await expect(drain).rejects.toThrow();
    const second = connection();
    const pending = second.transport.enqueue(
      new Blob(['audio']) as unknown as globalThis.Blob,
      1000,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(second.frames.length).toBeGreaterThanOrEqual(2);
    expect(new Uint8Array(second.frames[0]!)).toEqual(new Uint8Array(second.frames[1]!));
    second.transport.acknowledge({
      epochId: 'epoch-1',
      sequence: 0,
      durableBytes: 5,
      durableEndMs: 1000,
    });
    await pending;
    expect(frames).toHaveLength(1);
  });

  it('rejects an oversized backlog before retaining it', async () => {
    const { transport, frames } = connection();
    await expect(
      transport.enqueue(
        new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]) as unknown as globalThis.Blob,
        1000,
      ),
    ).rejects.toThrow('backlog');
    expect(frames).toHaveLength(0);
    expect(transport.backlogBytes).toBe(0);
  });
});
