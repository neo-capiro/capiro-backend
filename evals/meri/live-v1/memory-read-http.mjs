import https from 'node:https';
import { open, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { nativeMeriCaptureHeaders } from './lib/native-http.mjs';
import { AUTHORIZED_TENANTS } from './fixture-provisioning/contract.mjs';

/** Ordinary same-origin authenticated transport. The root operator supplies an
 * existing short-lived synthetic bearer in RAM and revokes its session finally.
 * No auth/bootstrap, redirect following, request injection or retry is provided. */
export function createMemoryReadHttp({ bearer, conversationId, timeoutMs }) {
  if (
    typeof bearer !== 'string' ||
    !bearer.trim() ||
    !/^[a-f0-9-]{36}$/iu.test(conversationId) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 900000
  )
    throw new Error('MEMORY_READ_TRANSPORT_CONFIG_INVALID');
  const origin = 'https://os.capiro.ai';
  const base = `/api/clio/conversations/${conversationId}`;
  const gets = new Set(['/api/me', '/api/clio/status', base, `${base}/messages`]);
  const deadline = Date.now() + timeoutMs;
  let requests = 0,
    attempted = false;
  return Object.freeze({
    request(path, body) {
      if (
        ++requests > 8 ||
        Date.now() >= deadline ||
        (body === undefined ? !gets.has(path) : path !== `${base}/stream` || attempted)
      )
        throw new Error('MEMORY_READ_TRANSPORT_BOUND');
      if (body !== undefined) attempted = true;
      return new Promise((resolve, reject) => {
        const request = https.request(
          new URL(path, origin),
          {
            method: body === undefined ? 'GET' : 'POST',
            rejectUnauthorized: true,
            headers: {
              ...nativeMeriCaptureHeaders(bearer, AUTHORIZED_TENANTS.T1.slug),
              accept: body === undefined ? 'application/json' : 'text/event-stream',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
          },
          (response) => {
            const chunks = [];
            let length = 0;
            response.on('data', (chunk) => {
              length += chunk.length;
              if (length > 8 * 1024 * 1024)
                request.destroy(new Error('MEMORY_READ_RESPONSE_LIMIT'));
              else chunks.push(chunk);
            });
            response.on('end', () => {
              clearTimeout(timer);
              try {
                resolve({
                  status: response.statusCode,
                  releaseSha: response.headers['x-capiro-release-sha'],
                  text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
                });
              } catch {
                reject(new Error('MEMORY_READ_RESPONSE_ENCODING'));
              }
            });
            response.on('error', () => {
              clearTimeout(timer);
              reject(new Error('MEMORY_READ_RESPONSE_INTERRUPTED'));
            });
          },
        );
        const timer = setTimeout(
          () => request.destroy(new Error('MEMORY_READ_DEADLINE')),
          Math.max(1, deadline - Date.now()),
        );
        request.on('error', () => {
          clearTimeout(timer);
          reject(new Error('MEMORY_READ_NETWORK_FAILED'));
        });
        if (body !== undefined) request.write(JSON.stringify(body));
        request.end();
      });
    },
  });
}

/** Exclusive task-local evidence only. This saves real observations and has no
 * special acceptance authority. Known credentials and token-shaped material are
 * rejected before writing; no request headers/session state are collected. */
export async function createMemoryReadRecorder(directory, { secrets = [] } = {}) {
  if (!isAbsolute(directory)) throw new Error('MEMORY_READ_EVIDENCE_PATH_INVALID');
  await mkdir(directory); // Existing paths are deliberately refused.
  return async (name, value) => {
    if (!/^[a-z][a-z-]*\.json$/u.test(name)) throw new Error('MEMORY_READ_EVIDENCE_NAME_INVALID');
    const bytes = JSON.stringify(value, null, 2) + '\n';
    if (
      secrets.some(
        (secret) => typeof secret === 'string' && secret.length && bytes.includes(secret),
      ) ||
      /Bearer\s+\S+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/u.test(bytes)
    )
      throw new Error('MEMORY_READ_SECRET_IN_EVIDENCE');
    const output = await open(join(directory, name), 'wx');
    try {
      await output.writeFile(bytes, 'utf8');
      await output.sync();
    } finally {
      await output.close();
    }
  };
}
