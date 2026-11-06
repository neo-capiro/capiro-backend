/** Task-local ClamAV scanning. No cached verdicts or external document transfer. */
import * as net from 'node:net';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AttachmentScanStatus } from './attachment-scanner.service.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4096;
const MAX_TIMEOUT_MS = 20_000;

/** z-prefixed commands require NUL-terminated responses, not newline replies. */
export function parseClamAvResponse(raw: string): AttachmentScanStatus {
  if (raw === 'stream: OK\0') return 'clean';
  if (/^stream: Heuristics\.(?:Encrypted|Limits\.Exceeded)[^\r\n\0]* FOUND\0$/.test(raw))
    return 'unsupported';
  if (/^stream: [^\r\n\0]+ FOUND\0$/.test(raw)) return 'threat';
  if (raw === 'INSTREAM size limit exceeded. ERROR\0') return 'unsupported';
  return 'failed';
}

export function buildInstreamCommand(data: Buffer): Buffer {
  const command = Buffer.from('zINSTREAM\0');
  const end = Buffer.alloc(4);
  if (data.length === 0) return Buffer.concat([command, end]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([command, length, data, end]);
}

export interface ClamAvScannerOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
  /** Bind the verdict to the bytes already verified by the upload/copy owner. */
  readonly expectedSha256?: string;
}

export async function clamAvScanObject(
  s3: S3Client,
  bucket: string,
  key: string,
  options: ClamAvScannerOptions = {},
): Promise<AttachmentScanStatus> {
  const port = options.port ?? 3310;
  const requestedTimeout = options.timeoutMs ?? 15_000;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(requestedTimeout) ||
    requestedTimeout <= 0 ||
    (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.expectedSha256))
  )
    return 'failed';
  const abort = new AbortController();
  let body: Readable | undefined;
  let socket: net.Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    abort.abort();
    body?.destroy();
    socket?.destroy();
  };
  const deadline = new Promise<AttachmentScanStatus>((resolve) => {
    timer = setTimeout(
      () => {
        dispose();
        resolve('failed');
      },
      Math.min(requestedTimeout, MAX_TIMEOUT_MS),
    );
  });
  const scan = async (): Promise<AttachmentScanStatus> => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: abort.signal,
    });
    body = object.Body instanceof Readable ? object.Body : undefined;
    if (abort.signal.aborted) {
      body?.destroy();
      return 'failed';
    }
    if (!(body instanceof Readable)) return 'failed';
    const declared = object.ContentLength;
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0))
      return 'failed';
    if (declared !== undefined && declared > MAX_BYTES) return 'unsupported';
    const chunks: Buffer[] = [];
    let bytes = 0;
    const digest = createHash('sha256');
    for await (const part of body) {
      if (abort.signal.aborted) return 'failed';
      if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) return 'failed';
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) return 'unsupported';
      digest.update(chunk);
      chunks.push(chunk);
    }
    if (abort.signal.aborted || (declared !== undefined && bytes !== declared)) return 'failed';
    if (
      options.expectedSha256 !== undefined &&
      digest.digest('hex') !== options.expectedSha256.toLowerCase()
    )
      return 'failed';
    const frame = buildInstreamCommand(Buffer.concat(chunks, bytes));
    return await new Promise<AttachmentScanStatus>((resolve) => {
      let settled = false,
        written = false;
      let response = Buffer.alloc(0);
      const finish = (status: AttachmentScanStatus) => {
        if (!settled) {
          settled = true;
          resolve(status);
        }
      };
      const evaluate = () => {
        if (written && response.includes(0)) finish(parseClamAvResponse(response.toString('utf8')));
      };
      socket = net.createConnection({ host: '127.0.0.1', port });
      socket.on('error', () => finish('failed'));
      socket.on('close', () => finish('failed'));
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (response.length + chunk.length > MAX_RESPONSE_BYTES) {
          finish('failed');
          return;
        }
        response = Buffer.concat([response, chunk]);
        evaluate();
      });
      socket.once('connect', () => {
        if (abort.signal.aborted) {
          finish('failed');
          return;
        }
        // Wait for the queued write; the operation deadline covers backpressure too.
        socket!.write(frame, (error) => {
          if (error) {
            finish('failed');
            return;
          }
          written = true;
          evaluate();
        });
      });
    });
  };
  try {
    return await Promise.race([scan(), deadline]);
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'AccessDenied' || [401, 403].includes(e?.$metadata?.httpStatusCode ?? 0)
      ? 'access_denied'
      : 'failed';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    dispose();
  }
}
