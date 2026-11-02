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
      // P2010: raw query failed — remapped only for a known Postgres cause:
      // 22P02 (invalid text representation, e.g. CAST('not-a-uuid' AS uuid)
      // in a hand-written $queryRaw WHERE clause) is the caller's 400; a
      // serialization failure or deadlock that outlived its retries
      // (40001 / 40P01) and a statement_timeout cancel (57014) are transient
      // 503s. Any other P2010 is a genuine server fault and keeps its 500.
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
      case 'P2010': {
        const pgCode = (exception.meta as { code?: string } | undefined)?.code;
        if (pgCode === '22P02') {
          this.logger.warn(`Prisma P2010/22P02 mapped to 400: ${lastLine(exception.message)}`);
          res
            .status(HttpStatus.BAD_REQUEST)
            .json({ statusCode: HttpStatus.BAD_REQUEST, message: 'Invalid request parameter' });
          return;
        }
        if (pgCode === '40001' || pgCode === '40P01') {
          transientUnavailable(this.logger, res, `P2010/${pgCode}`, 'transaction conflict', exception);
          return;
        }
        if (pgCode === '57014') {
          transientUnavailable(this.logger, res, 'P2010/57014', 'statement timeout', exception);
          return;
        }
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
        transientUnavailable(this.logger, res, exception.code, 'database capacity', exception);
        return;
      // P2034: write conflict or deadlock reported by Prisma itself.
      case 'P2034':
        transientUnavailable(this.logger, res, exception.code, 'transaction conflict', exception);
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

/**
 * ERROR, not warn: 503 is the honest answer to the caller, but a starved pool,
 * a cancelled statement or an exhausted conflict retry is a real server-side
 * condition that must stay visible in the logs and in 5xx alarms.
 */
function transientUnavailable(
  logger: Logger,
  res: Response,
  code: string,
  cause: string,
  exception: Prisma.PrismaClientKnownRequestError,
): void {
  logger.error(`Prisma ${code} mapped to 503 (${cause}): ${lastLine(exception.message)}`);
  res.status(HttpStatus.SERVICE_UNAVAILABLE).setHeader('Retry-After', '2').json({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The database is temporarily busy. Please retry.',
  });
}

/** Last line of a multi-line Prisma message — the human-readable cause. */
function lastLine(message: string): string {
  return message.split('\n').pop() ?? message;
}
