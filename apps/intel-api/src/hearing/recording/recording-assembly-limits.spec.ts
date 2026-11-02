import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
jest.mock('node:child_process', () => {
  const run = jest.fn();
  return {
    execFile: Object.assign(jest.fn(), { [require('node:util').promisify.custom]: run }),
    run,
  };
});
jest.mock('../hearing-session.service.js', () => ({ CAPTURE_LEASE_STALE_MS: 60_000 }));
import { RecordingAssemblyWorker } from './recording-assembly.worker.js';

it.each(['dimensions', 'codec', 'frame_rate', 'extra_track'])(
  'rejects invalid %s before launching any ffmpeg mux or decoder',
  async (invalid) => {
    const run = jest.requireMock('node:child_process').run as jest.Mock;
    run.mockReset();
    const streams = [
      { codec_type: 'audio', codec_name: 'opus' },
      {
        codec_type: 'video',
        codec_name: invalid === 'codec' ? 'h264' : 'vp8',
        width: invalid === 'dimensions' ? 8192 : 1280,
        height: 720,
        r_frame_rate: invalid === 'frame_rate' ? '60/1' : '24/1',
      },
    ];
    if (invalid === 'extra_track')
      streams.push({ codec_type: 'subtitle', codec_name: 'webvtt' });
    run.mockResolvedValue({ stdout: JSON.stringify({ streams }) });
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'epoch', tenant_id: 'tenant' }]),
      hearingRecordingEpoch: {
        update: jest
          .fn()
          .mockResolvedValue({
            id: 'epoch',
            tenantId: 'tenant',
            recordingId: 'recording',
            mimeType: 'video/webm;codecs=vp8,opus',
            durableSequence: 0,
            durableBytes: 4n,
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      hearingRecording: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      hearingRecordingPart: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              sequence: 0,
              objectKey: 'synthetic',
              byteLength: 4,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ])
          .mockResolvedValue([]),
      },
    };
    const storage = {
      assertReady: jest.fn(),
      read: jest.fn(async () => Readable.from([bytes])),
      put: jest.fn(),
    };
    const worker = new RecordingAssemblyWorker(
      { withSystem: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as never,
      storage as never,
    );
    await expect(worker.runOne()).rejects.toThrow();
    expect(run.mock.calls.map((call) => call[0])).toEqual(['ffprobe']);
    expect(storage.put).not.toHaveBeenCalled();
    expect(tx.hearingRecordingEpoch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
  },
);
