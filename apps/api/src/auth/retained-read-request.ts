import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  parseRetainedReadBody as parseSharedRetainedReadBody,
  CoreRetainedReadRequestInvalidError, CoreRetainedReadRequestUnavailableError,
  type RetainedReadOperation, type ParsedRetainedReadBody, type CoreRetainedReadCanonicalizer,
} from '@capiro/shared/core-retained-read-request';

export type { ParsedRetainedReadBody, CoreRetainedReadCanonicalizer } from '@capiro/shared/core-retained-read-request';

/** Core HTTP error adapter; the single shared server parser owns all admission
 * and normalization. Intel consumes that same parser through its own adapter. */
export function parseRetainedReadBody(
  operation: RetainedReadOperation,
  raw: unknown,
  options: { issuer: boolean },
  canonicalize: CoreRetainedReadCanonicalizer,
): ParsedRetainedReadBody {
  try { return parseSharedRetainedReadBody(operation, raw, options, canonicalize); }
  catch (error) {
    if (error instanceof CoreRetainedReadRequestInvalidError) throw new BadRequestException(error.message);
    if (error instanceof CoreRetainedReadRequestUnavailableError) throw new ServiceUnavailableException(error.message);
    throw error;
  }
}
