import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Maps known Prisma errors to correct HTTP status codes instead of letting
 * them fall through to a generic 500.
 *
 * The motivating case: a malformed path param (e.g. a non-UUID client id like
 * `/clients/not-a-uuid`) makes Postgres reject the value and Prisma throw
 * `P2023`. Without this filter that surfaced as a 500 — a client error
 * reported as a server error, which also pollutes 5xx alarms.
 *
 * Only well-understood codes are remapped; anything else preserves the prior
 * 500 behavior so we don't accidentally mask a real server fault.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PrismaExceptionFilter');

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    // A Prisma error can surface after a response has started streaming (SSE
    // endpoints run queries mid-stream). Writing status/JSON then would throw
    // ERR_HTTP_HEADERS_SENT from inside the filter — an unhandled rejection
    // that takes down the process on Node 20. End the stream instead.
    if (res.headersSent) {
      this.logger.error(
        `Prisma error ${exception.code} after response started: ${lastLine(exception.message)}`,
        exception.stack,
      );
      res.end();
      return;
    }

    switch (exception.code) {
      // P2023: inconsistent column data (e.g. invalid UUID syntax in a param).
      // P2000: value too long for the column's type.
      case 'P2023':
      case 'P2000':
        // Warn-log even though we answer 400: this branch reclassifies the
        // error as the client's fault, so without a log line a server-side
        // bad-value bug (e.g. a sync job building a malformed where-clause)
        // would vanish from both the 5xx alarms and the logs.
        this.logger.warn(`Prisma ${exception.code} mapped to 400: ${lastLine(exception.message)}`);
        res
          .status(HttpStatus.BAD_REQUEST)
          .json({ statusCode: HttpStatus.BAD_REQUEST, message: 'Invalid request parameter' });
        return;
      // P2025: an operation depended on a record that does not exist.
      case 'P2025':
        res
          .status(HttpStatus.NOT_FOUND)
          .json({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found' });
        return;
      // P2024: timed out fetching a connection from the pool.
      // P2028: transaction API error — in practice "Unable to start a
      // transaction in the given time", the same pool exhaustion one layer up.
      // Neither is a fault in the request that happened to lose the race: a
      // burst of background Graph syncs can starve the pool and make an
      // unrelated save fail. Reporting 500 made that look like a bug in
      // whatever the user was saving, with no hint that a retry would work.
      case 'P2024':
      case 'P2028':
        // ERROR, not warn: 503 is the honest answer to the caller, but a
        // starved pool is a real server-side condition that must stay visible
        // in the logs and in 5xx alarms.
        this.logger.error(
          `Prisma ${exception.code} mapped to 503 (database capacity): ${lastLine(exception.message)}`,
        );
        res.status(HttpStatus.SERVICE_UNAVAILABLE).setHeader('Retry-After', '2').json({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'The database is temporarily busy. Please retry.',
        });
        return;
      default:
        // Preserve the previous 500 for anything we don't explicitly map, but
        // keep the full message, meta (model/column/target), and stack that
        // Nest's default handler would have logged.
        this.logger.error(
          `Unhandled Prisma error ${exception.code}: ${exception.message}` +
            (exception.meta ? ` meta=${JSON.stringify(exception.meta)}` : ''),
          exception.stack,
        );
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
        });
        return;
    }
  }
}

/** Last line of a multi-line Prisma message — the human-readable cause. */
function lastLine(message: string): string {
  return message.split('\n').pop() ?? message;
}
