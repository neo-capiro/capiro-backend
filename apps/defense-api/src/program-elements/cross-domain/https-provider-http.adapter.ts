/**
 * Phase 8 Session 9 — real provider HTTP transport.
 *
 * One attempt per call: retry, backoff and the total budget are the runner's job,
 * so this stays a thin, classified single exchange. It never throws — a transport
 * error is a classified outcome, because the ports above it are documented to
 * degrade rather than raise.
 *
 * Session 8 established the redirect rule for outbound requests and it applies
 * with more force here, because these requests carry a credential:
 * `redirect: 'manual'` and a same-origin check on every hop, so a provider or a
 * misconfigured proxy cannot bounce an authenticated request to another host.
 * A cross-origin redirect is refused outright rather than followed.
 */

import { Injectable, Logger } from '@nestjs/common';

import { classifyHttpStatus, type ProviderFailureClass } from '@capiro/defense-domain';

import type { ProviderHttpPort, ProviderHttpResult } from './provider-runtime.ports.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'Capiro-Phase8-Session9-ProviderRuntime/1.0';

@Injectable()
export class HttpsProviderHttpAdapter implements ProviderHttpPort {
  private readonly logger = new Logger(HttpsProviderHttpAdapter.name);

  async post(input: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: unknown;
    timeoutMs: number;
  }): Promise<ProviderHttpResult> {
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      return failure('invalid_request', `malformed provider url: ${input.url}`);
    }
    if (target.protocol !== 'https:') {
      // A credential must never travel in plaintext.
      return failure('invalid_request', `refusing non-https provider url: ${target.origin}`);
    }

    const origin = target.origin;
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { ...input.headers, 'user-agent': USER_AGENT },
        body: JSON.stringify(input.body),
        // Manual, so a redirect cannot carry the credential to another origin.
        redirect: 'manual',
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A timeout is retryable; any other transport fault is classified as such.
      const isTimeout = /abort|timeout|timed out/i.test(message);
      return failure(isTimeout ? 'timeout' : 'transport', message);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      let redirectOrigin: string | null = null;
      try {
        redirectOrigin = location ? new URL(location, target).origin : null;
      } catch {
        redirectOrigin = null;
      }
      // Even a same-origin redirect is refused: the runner owns retry, and
      // silently re-POSTing an authenticated body is not this seam's decision.
      this.logger.warn(
        `provider ${origin} answered ${response.status} redirect` +
          (redirectOrigin && redirectOrigin !== origin
            ? ` to a DIFFERENT origin ${redirectOrigin}; refused`
            : '; refused'),
      );
      return failure(
        redirectOrigin && redirectOrigin !== origin ? 'invalid_request' : 'unavailable',
        `provider returned a ${response.status} redirect, which is not followed`,
      );
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    if (!response.ok) {
      return Object.freeze({
        ok: false,
        statusCode: response.status,
        body: null,
        failureClass: classifyHttpStatus(response.status),
        retryAfterMs,
        detail: `provider ${origin} returned HTTP ${response.status}`,
      });
    }

    let text: string;
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_RESPONSE_BYTES) {
        return failure('malformed_response', `provider response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      text = bytes.toString('utf8');
    } catch (error) {
      return failure('transport', error instanceof Error ? error.message : String(error));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A 200 that is not JSON is malformed, not a success with no data.
      return failure('malformed_response', 'provider returned a 200 with a non-JSON body');
    }

    return Object.freeze({
      ok: true,
      statusCode: response.status,
      body: parsed,
      failureClass: null,
      retryAfterMs,
      detail: null,
    });
  }
}

function failure(failureClass: ProviderFailureClass, detail: string): ProviderHttpResult {
  return Object.freeze({
    ok: false,
    statusCode: null,
    body: null,
    failureClass,
    retryAfterMs: null,
    detail,
  });
}

/** `Retry-After` in either legal form; anything unparseable is ignored. */
export function parseRetryAfter(headerValue: string | null): number | null {
  const raw = headerValue?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1_000;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - Date.now());
}
