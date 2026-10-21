import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import { json, raw, type RequestHandler } from 'express';

/** The Strategy routes registered by objective-workload-jwt, not every internal
 * Planner route. Producer admission/application authority has a separate owner. */
const ROOT = '/strategy-api/internal/objective-canonical';
const POSTS = new Set(['generation-admissions', 'generation-requests',
  'generation-acceptances', 'generation-completions', 'generation-terminals']
  .map(route => `${ROOT}/${route}`));
const GET = new RegExp(`^${ROOT}/generation-(?:admissions|requests|completions|terminals)/` +
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
export const OBJECTIVE_GENERATION_RAW_BODY_LIMIT = 8 * 1024 * 1024;

function capture(request: object, entity: Buffer): void {
  Object.defineProperty(request, 'rawBody', {
    value: Buffer.from(entity), enumerable: false, writable: false, configurable: false,
  });
}

/** Transport prerequisite only. No credential/header authentication, native
 * authority, JSON canonicalization or authority fallback is supplied here.
 * Preserve the existing JSON parser's media/charset grammar and parsed @Body;
 * the signed digest instead uses the original bytes from its verify hook. */
export function objectiveGenerationRawBody(): RequestHandler {
  const parse = json({
    limit: OBJECTIVE_GENERATION_RAW_BODY_LIMIT,
    inflate: false,
    verify(request, _response, entity) {
      if (entity.length === 0) throw new BadRequestException('Objective body bytes unavailable');
      capture(request, entity);
    },
  });
  const parseEmpty = raw({
    type: () => true, limit: 0, inflate: false,
    verify(request, _response, entity) { capture(request, entity); },
  });
  return (request, response, next) => {
    const post = request.method === 'POST' && POSTS.has(request.originalUrl);
    const get = request.method === 'GET' && GET.test(request.originalUrl);
    // originalUrl deliberately excludes query strings and URL aliases.
    if (!post && !get) { next(); return; }
    if (Object.getOwnPropertyDescriptor(request, 'rawBody')) {
      next(new BadRequestException('Objective body bytes unavailable')); return;
    }
    const encoding = request.headers['content-encoding'];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
      next(new UnsupportedMediaTypeException('Encoded Objective bodies are unsupported')); return;
    }
    const framed = request.headers['content-length'] !== undefined ||
      request.headers['transfer-encoding'] !== undefined;
    if (post || framed) {
      (post ? parse : parseEmpty)(request, response, error => {
        if (error) { next(error); return; }
        // A skipped parser (including an empty entity) is never evidence of
        // captured bytes. Do not reconstruct them from req.body.
        if (!Object.getOwnPropertyDescriptor(request, 'rawBody')) {
          next(new BadRequestException('Objective body bytes unavailable')); return;
        }
        next();
      });
      return;
    }

    // Normal Meri GETs have no Content-Length or Transfer-Encoding. body-parser
    // skips them, so its callback/req.body cannot prove an empty entity. Observe
    // the stream's real end instead; any entity byte or uncertainty stays closed.
    if (request.readableEnded || request.aborted || request.destroyed || request.socket.destroyed) {
      next(new BadRequestException('Objective body bytes unavailable')); return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', failed);
      request.removeListener('close', failed);
      if (error) { next(error); return; }
      capture(request, Buffer.alloc(0));
      next();
    };
    const data = () => finish(new BadRequestException('Objective reads require an empty body'));
    const end = () => finish();
    const aborted = () => finish(new BadRequestException('Objective body bytes unavailable'));
    const failed = () => finish(new BadRequestException('Objective body bytes unavailable'));
    request.once('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', failed);
    request.once('close', failed);
    request.resume();
  };
}
