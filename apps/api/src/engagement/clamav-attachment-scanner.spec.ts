/**
 * ClamAV attachment scanner — protocol conformance + fail-closed tests.
 *
 * All tests use a local fake TCP server (net.createServer) and mocked S3
 * Readable streams. No production network connections are made; the daemon
 * is not required. This file tests REAL framing bytes, protocol paths, and
 * fail-closed behavior.
 *
 * These tests are protocol simulations, not proof of real malware detection.
 * The independent boundary suite covers actual z-command terminators and
 * operation-wide cancellation. Real-daemon qualification is recorded separately.
 *
 * Real-daemon qualification additionally needs:
 *   - Actual virus signature detection with EICAR test file
 *   - StreamMaxLength behavior with clamd.conf tuning
 *   - Real connection refused / daemon restart recovery
 *   - Real encrypted ZIP handling
 */

import * as net from 'node:net';
import { Readable } from 'node:stream';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  parseClamAvResponse,
  buildInstreamCommand,
  clamAvScanObject,
} from './clamav-attachment-scanner.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a fake TCP server that responds to one INSTREAM connection. */
function createFakeClamd(
  responseFactory: (received: Buffer) => string,
  opts: { closeBeforeResponse?: boolean; hangForever?: boolean; port?: number } = {},
): Promise<{ port: number; server: net.Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (opts.hangForever) return;
        if (opts.closeBeforeResponse) {
          socket.destroy();
          return;
        }
        // ClamAV only responds after it has received the zero terminator.
        // Detect end: the last 4 bytes are all zero.
        const full = Buffer.concat(chunks);
        if (full.length >= 4) {
          const tail = full.slice(-4);
          if (tail.readUInt32BE(0) === 0) {
            const response = responseFactory(full);
            socket.write(response + '\0', () => socket.end());
          }
        }
      });
      socket.on('error', () => {
        /* swallow */
      });
    });

    const port = opts.port ?? 0;
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        server,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** Creates a mock S3 client that streams the given bytes. */
function mockS3(
  bytes: Buffer | null,
  opts: { httpStatusCode?: number; accessDenied?: boolean } = {},
): {
  send: jest.Mock;
} {
  const send = jest.fn(async (_command: unknown) => {
    if (opts.accessDenied) {
      const err = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
      throw err;
    }
    if (opts.httpStatusCode && opts.httpStatusCode !== 200) {
      const err = Object.assign(new Error(`HTTP ${opts.httpStatusCode}`), {
        $metadata: { httpStatusCode: opts.httpStatusCode },
      });
      throw err;
    }
    if (bytes === null) {
      return { Body: null, ContentLength: 0 };
    }
    const stream = Readable.from([bytes]);
    return { Body: stream, ContentLength: bytes.length };
  });
  return { send } as { send: jest.Mock };
}

// ── parseClamAvResponse ────────────────────────────────────────────────────

describe('parseClamAvResponse — framing grammar', () => {
  // RED note: before implementation, these expectations documented exact grammar.

  test('exact NUL-terminated "stream: OK" → clean; missing terminator → failed', () => {
    expect(parseClamAvResponse('stream: OK\0')).toBe('clean');
    expect(parseClamAvResponse('stream: OK')).toBe('failed');
  });

  test('" FOUND" suffix → threat', () => {
    expect(parseClamAvResponse('stream: Eicar-Signature FOUND\0')).toBe('threat');
    expect(parseClamAvResponse('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toBe('threat');
  });

  test('INSTREAM size limit exceeded → unsupported', () => {
    expect(parseClamAvResponse('INSTREAM size limit exceeded. ERROR\0')).toBe('unsupported');
  });

  test('Encrypted ZIP → unsupported', () => {
    expect(parseClamAvResponse('stream: Heuristics.Encrypted.Zip FOUND\0')).toBe('unsupported');
    expect(parseClamAvResponse('stream: Heuristics.Encrypted.RAR FOUND\0')).toBe('unsupported');
  });

  test('unknown ERROR line → failed', () => {
    expect(parseClamAvResponse('lstat() failed. ERROR\n')).toBe('failed');
    expect(parseClamAvResponse('Cannot parse stream. ERROR\n')).toBe('failed');
  });

  test('empty / whitespace response → failed (no match)', () => {
    expect(parseClamAvResponse('')).toBe('failed');
    expect(parseClamAvResponse('  \n  ')).toBe('failed');
  });

  test('partial / missing terminator → failed', () => {
    // A response that has no newline and is not "OK" is treated as failed.
    expect(parseClamAvResponse('stream: O')).toBe('failed');
  });
});

// ── buildInstreamCommand ───────────────────────────────────────────────────

describe('buildInstreamCommand — framing bytes', () => {
  test('starts with zINSTREAM NUL', () => {
    const buf = buildInstreamCommand(Buffer.from('hello'));
    // First 10 bytes: z I N S T R E A M \0
    expect(buf.slice(0, 10)).toEqual(Buffer.from('zINSTREAM\0'));
  });

  test('encodes data length as uint32 big-endian', () => {
    const data = Buffer.from('hello world');
    const buf = buildInstreamCommand(data);
    // Bytes 10..13 = uint32 big-endian length of data
    expect(buf.readUInt32BE(10)).toBe(data.length);
  });

  test('data bytes follow the length', () => {
    const data = Buffer.from('hello world');
    const buf = buildInstreamCommand(data);
    expect(buf.slice(14, 14 + data.length)).toEqual(data);
  });

  test('ends with 4-byte zero terminator', () => {
    const data = Buffer.from('test');
    const buf = buildInstreamCommand(data);
    expect(buf.readUInt32BE(buf.length - 4)).toBe(0);
  });

  test('empty data produces header + one zero-length terminator', () => {
    const buf = buildInstreamCommand(Buffer.alloc(0));
    // The zero-length frame itself terminates an empty stream.
    expect(buf.length).toBe(14);
    expect(buf.readUInt32BE(10)).toBe(0);
  });
});

// ── clamAvScanObject — protocol integration ────────────────────────────────

describe('clamAvScanObject — clean result', () => {
  let clamd: Awaited<ReturnType<typeof createFakeClamd>>;

  beforeEach(async () => {
    clamd = await createFakeClamd(() => 'stream: OK');
  });
  afterEach(async () => {
    await clamd.close();
  });

  test('returns clean when clamd responds "stream: OK"', async () => {
    const bytes = Buffer.from('clean synthetic file');
    const s3 = mockS3(bytes);
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: clamd.port,
      timeoutMs: 5000,
    });
    expect(status).toBe('clean');
  });

  test('actual bytes sent include the zINSTREAM header', async () => {
    let received: Buffer = Buffer.alloc(0);
    const bytes = Buffer.from('actual bytes');
    // Intercept by recreating a server that captures data before responding.
    const interceptServer = await createFakeClamd((data) => {
      received = data;
      return 'stream: OK';
    });
    const s3 = mockS3(bytes);
    await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: interceptServer.port,
      timeoutMs: 5000,
    });
    await interceptServer.close();
    // Verify the framing: first 10 bytes must be zINSTREAM\0
    expect(received.slice(0, 10)).toEqual(Buffer.from('zINSTREAM\0'));
    // Length in bytes 10..13 must equal actual data length
    expect(received.readUInt32BE(10)).toBe(bytes.length);
    // Last 4 bytes = terminator
    expect(received.readUInt32BE(received.length - 4)).toBe(0);
  });
});

describe('clamAvScanObject — threat detection', () => {
  let clamd: Awaited<ReturnType<typeof createFakeClamd>>;

  beforeEach(async () => {
    clamd = await createFakeClamd(() => 'stream: Eicar-Signature FOUND');
  });
  afterEach(async () => {
    await clamd.close();
  });

  test('returns threat when clamd reports FOUND', async () => {
    const bytes = Buffer.from('eicar test content');
    const s3 = mockS3(bytes);
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: clamd.port,
      timeoutMs: 5000,
    });
    expect(status).toBe('threat');
  });
});

describe('clamAvScanObject — oversized object', () => {
  test('ContentLength exceeding 25 MiB returns unsupported without streaming', async () => {
    // No clamd needed; the adapter bails before connecting.
    const s3 = {
      send: jest.fn(async () => ({
        Body: Readable.from([Buffer.alloc(1)]),
        ContentLength: 26 * 1024 * 1024,
      })),
    };
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 39999, // port that should not be reached
      timeoutMs: 5000,
    });
    expect(status).toBe('unsupported');
  });

  test('actual stream overflow (no ContentLength) returns unsupported', async () => {
    // 27 MiB stream with no declared ContentLength → triggers byte cap during S3 read.
    // No fake clamd needed — the oversize detection happens before connecting.
    const bigStream = Readable.from(
      (async function* () {
        const chunk = Buffer.alloc(1024 * 1024); // 1 MiB chunks
        for (let i = 0; i < 27; i++) {
          yield chunk;
        }
      })(),
    );
    const s3 = {
      send: jest.fn(async () => ({ Body: bigStream, ContentLength: undefined })),
    };
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 39999, // won't be reached
      timeoutMs: 10_000,
    });
    expect(status).toBe('unsupported');
  });
});

describe('clamAvScanObject — absent body', () => {
  test('returns failed when S3 returns null body', async () => {
    const s3 = mockS3(null);
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 39999,
      timeoutMs: 5000,
    });
    expect(status).toBe('failed');
  });
});

describe('clamAvScanObject — S3 access denied', () => {
  test('returns access_denied on 403 AccessDenied', async () => {
    const s3 = mockS3(null, { accessDenied: true });
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 39999,
      timeoutMs: 5000,
    });
    expect(status).toBe('access_denied');
  });

  test('returns access_denied on 401', async () => {
    const s3 = {
      send: jest.fn(async () => {
        throw Object.assign(new Error('Unauthorized'), {
          name: 'AuthFailure',
          $metadata: { httpStatusCode: 401 },
        });
      }),
    };
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 39999,
      timeoutMs: 5000,
    });
    expect(status).toBe('access_denied');
  });

  test('returns failed (not access_denied) on generic S3 error', async () => {
    const s3 = {
      send: jest.fn(async () => {
        throw Object.assign(new Error('ServiceUnavailable'), {
          $metadata: { httpStatusCode: 503 },
        });
      }),
    };
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 39999,
      timeoutMs: 5000,
    });
    expect(status).toBe('failed');
  });
});

describe('clamAvScanObject — timeout and disconnect', () => {
  test('returns failed when clamd closes without responding', async () => {
    const clamd = await createFakeClamd(() => '', { closeBeforeResponse: true });
    try {
      const s3 = mockS3(Buffer.from('test'));
      const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
        port: clamd.port,
        timeoutMs: 5000,
      });
      expect(status).toBe('failed');
    } finally {
      await clamd.close();
    }
  });

  test('returns failed when whole-operation timeout fires', async () => {
    const clamd = await createFakeClamd(() => 'stream: OK', { hangForever: true });
    try {
      const s3 = mockS3(Buffer.from('small'));
      const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
        port: clamd.port,
        timeoutMs: 200, // very short timeout to exercise the timer
      });
      expect(status).toBe('failed');
    } finally {
      await clamd.close();
    }
  }, 5000);

  test('returns failed when port has no listener (connection refused)', async () => {
    // Port 1 is almost certainly unbound. If it happens to be bound, the test
    // may return 'failed' for a different reason, which is still correct.
    const s3 = mockS3(Buffer.from('test'));
    const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
      port: 1,
      timeoutMs: 3000,
    });
    expect(status).toBe('failed');
  }, 8000);
});

describe('clamAvScanObject — malformed and extra response', () => {
  test('returns failed on unrecognized ERROR response', async () => {
    const clamd = await createFakeClamd(() => 'Something unexpected. ERROR');
    try {
      const s3 = mockS3(Buffer.from('test'));
      const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
        port: clamd.port,
        timeoutMs: 5000,
      });
      expect(status).toBe('failed');
    } finally {
      await clamd.close();
    }
  });

  test('returns unsupported on INSTREAM size limit exceeded', async () => {
    const clamd = await createFakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    try {
      const s3 = mockS3(Buffer.from('test'));
      const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
        port: clamd.port,
        timeoutMs: 5000,
      });
      expect(status).toBe('unsupported');
    } finally {
      await clamd.close();
    }
  });

  test('returns unsupported on Encrypted ZIP', async () => {
    const clamd = await createFakeClamd(() => 'stream: Heuristics.Encrypted.Zip FOUND');
    try {
      const s3 = mockS3(Buffer.from('test'));
      const status = await clamAvScanObject(s3 as never, 'bucket', 'key', {
        port: clamd.port,
        timeoutMs: 5000,
      });
      expect(status).toBe('unsupported');
    } finally {
      await clamd.close();
    }
  });
});
