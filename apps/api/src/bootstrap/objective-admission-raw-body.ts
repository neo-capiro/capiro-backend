import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import { raw, type Request, type RequestHandler } from 'express';

/** Fixed signed decision ingress, not a configurable raw-body facility. */
export const OBJECTIVE_DECISION_RAW_BODY_PATH = '/api/internal/objective-workload-authority/decisions';
/** Matches the closed issuance ingress's maximum entity-byte length. */
export const OBJECTIVE_DECISION_RAW_BODY_LIMIT = 4096;
const JSON_UTF8 = /^[ \t]*application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|utf8|"utf-8"|"utf8")[ \t]*)?$/i;

function originalHeaders(request: Request, name: string): string[] {
  const headers = request.rawHeaders;
  if (!Array.isArray(headers) || headers.length % 2 !== 0) throw new BadRequestException('Invalid decision headers');
  const values: string[] = [];
  for (let i = 0; i < headers.length; i += 2) {
    if (typeof headers[i] !== 'string' || typeof headers[i + 1] !== 'string')
      throw new BadRequestException('Invalid decision headers');
    if (headers[i]!.toLowerCase() === name) values.push(headers[i + 1]!);
  }
  return values;
}

/** Install before the existing JSON parser, while Nest's ordinary parser
 * registration stays enabled. The binary parser preserves entity bytes (even
 * BOM/invalid JSON); only the independently authenticated ingress can interpret
 * them. Compression is refused instead of hashing transformed/decompressed data.
 * URL aliases and queries deliberately receive no capture and cannot pass the
 * controller's own raw-body requirement or the ingress's exact URL check. */
export function objectiveAdmissionRawBody(): RequestHandler {
  const parse = raw({
    type: () => true,
    limit: OBJECTIVE_DECISION_RAW_BODY_LIMIT,
    inflate: false,
    verify(request, _response, entity) {
      // Keep an independent copy: req.body is the raw parser's buffer and may
      // be consumed by other code. Never serialize a parsed body into proof.
      Object.defineProperty(request, 'rawBody', {
        value: Buffer.from(entity), enumerable: false, writable: false, configurable: false,
      });
    },
  });
  return (request, response, next) => {
    if (request.method !== 'POST' || request.originalUrl !== OBJECTIVE_DECISION_RAW_BODY_PATH) {
      next(); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    try {
      const contentType = originalHeaders(request, 'content-type');
      const encoding = originalHeaders(request, 'content-encoding');
      if (contentType.length > 1 || encoding.length > 1 ||
          contentType[0] !== request.headers['content-type'] || encoding[0] !== request.headers['content-encoding'] ||
          Object.getOwnPropertyDescriptor(request, 'rawBody'))
        throw new BadRequestException('Invalid decision headers');
      if (contentType.length !== 1 || !JSON_UTF8.test(contentType[0]!))
        throw new UnsupportedMediaTypeException('Decision content type must be UTF-8 JSON');
      if (encoding.length && encoding[0]!.trim().toLowerCase() !== 'identity')
        throw new UnsupportedMediaTypeException('Encoded decision bodies are unsupported');
      parse(request, response, next);
    } catch (error) { next(error); }
  };
}
