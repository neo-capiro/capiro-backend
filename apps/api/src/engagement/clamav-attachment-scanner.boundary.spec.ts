import * as net from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, test, jest } from '@jest/globals';
import { configSchema } from '../config/config.schema.js';
import { ClamAvAttachmentScanner } from './attachment-scanner.service.js';
import { clamAvScanObject, parseClamAvResponse } from './clamav-attachment-scanner.js';

async function daemon(reply: string) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = Buffer.alloc(0);
    socket.on('data', (part) => {
      data = Buffer.concat([data, part]);
      if (data.length < 10) return;
      if (!data.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) {
        socket.destroy();
        return;
      }
      let offset = 10;
      while (offset + 4 <= data.length) {
        const size = data.readUInt32BE(offset);
        offset += 4;
        if (!size) {
          socket.end(reply);
          return;
        }
        if (offset + size > data.length) return;
        offset += size;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const bounded = async <T>(p: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      p,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('DID_NOT_SETTLE'), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
};

describe('real zINSTREAM framing and whole-operation deadlines', () => {
  test('fails closed without throwing when the SDK body is not a readable stream', async () => {
    const s3 = { send: jest.fn(async () => ({ Body: {}, ContentLength: 0 })) };
    await expect(
      clamAvScanObject(s3 as never, 'owned', 'fixture', { timeoutMs: 20 }),
    ).resolves.toBe('failed');
  });
  test('keeps the configured scan deadline below the 30-second web proxy deadline', () => {
    const field = configSchema.shape.ENGAGEMENT_CLAMAV_TIMEOUT_MS;
    expect(field.parse(undefined)).toBe(15000);
    expect(field.safeParse(20001).success).toBe(false);
    expect(field.parse(20000)).toBe(20000);
  });
  test('accepts the real NUL-terminated response required by the z command', async () => {
    const d = await daemon('stream: OK\0');
    try {
      const s3 = {
        send: jest.fn(async () => ({
          Body: Readable.from([Buffer.from('safe test')]),
          ContentLength: 9,
        })),
      };
      await expect(
        clamAvScanObject(s3 as never, 'owned', 'fixture', { port: d.port, timeoutMs: 50 }),
      ).resolves.toBe('clean');
    } finally {
      await d.close();
    }
  });
  test('recognizes a NUL-terminated threat verdict', async () => {
    const d = await daemon('stream: Win.Test.EICAR_HDB-1 FOUND\0');
    try {
      const s3 = {
        send: jest.fn(async () => ({
          Body: Readable.from([Buffer.from('test')]),
          ContentLength: 4,
        })),
      };
      await expect(
        clamAvScanObject(s3 as never, 'owned', 'fixture', { port: d.port, timeoutMs: 50 }),
      ).resolves.toBe('threat');
    } finally {
      await d.close();
    }
  });
  test('times out and aborts a stalled S3 GetObject, not just TCP scanning', async () => {
    let signal: AbortSignal | undefined;
    const s3 = {
      send: jest.fn((_c: unknown, options?: { abortSignal: AbortSignal }) => {
        signal = options?.abortSignal;
        return new Promise(() => {});
      }),
    };
    expect(
      await bounded(clamAvScanObject(s3 as never, 'owned', 'fixture', { timeoutMs: 20 })),
    ).toBe('failed');
    expect(signal?.aborted).toBe(true);
  });
  test('times out and destroys a stalled S3 body before TCP connection', async () => {
    const body = new Readable({ read() {} });
    const s3 = { send: jest.fn(async () => ({ Body: body, ContentLength: 10 })) };
    try {
      expect(
        await bounded(clamAvScanObject(s3 as never, 'owned', 'fixture', { timeoutMs: 20 })),
      ).toBe('failed');
      expect(body.destroyed).toBe(true);
    } finally {
      body.destroy();
    }
  });
  test('rejects a changed object even if the daemon offers a clean verdict', async () => {
    const d = await daemon('stream: OK\n');
    try {
      const s3 = {
        send: jest.fn(async () => ({
          Body: Readable.from([Buffer.from('replacement')]),
          ContentLength: 11,
        })),
      };
      await expect(
        clamAvScanObject(s3 as never, 'owned', 'fixture', {
          port: d.port,
          timeoutMs: 50,
          expectedSha256: 'a'.repeat(64),
        }),
      ).resolves.toBe('failed');
    } finally {
      await d.close();
    }
  });
  test('forwards the owner digest through the configured scanner adapter', async () => {
    const d = await daemon('stream: OK\0');
    try {
      const s3 = {
        send: jest.fn(async () => ({
          Body: Readable.from([Buffer.from('replacement')]),
          ContentLength: 11,
        })),
      };
      const scanner = new ClamAvAttachmentScanner(s3 as never, d.port, 50);
      await expect(scanner.getStatus('owned', 'fixture', 'a'.repeat(64))).resolves.toBe('failed');
    } finally {
      await d.close();
    }
  });
  test('does not turn an unframed or multi-message response into clean', () => {
    for (const s of ['stream: OK', 'stream: OK\n', 'stream: OK\0extra', 'stream: OK\0stream: OK\0'])
      expect(parseClamAvResponse(s)).toBe('failed');
  });
});
