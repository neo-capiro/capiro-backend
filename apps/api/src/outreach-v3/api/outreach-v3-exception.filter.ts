import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { OutreachCommandError } from '../state/outreach-command-errors.js';

@Catch(OutreachCommandError, ZodError)
export class OutreachV3ExceptionFilter implements ExceptionFilter {
  catch(exception: OutreachCommandError | ZodError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof OutreachCommandError) {
      response.status(exception.httpStatus).json({
        statusCode: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        ...(exception.safeMetadata ? { metadata: exception.safeMetadata } : {}),
      });
      return;
    }

    response.status(400).json({
      statusCode: 400,
      code: 'OUTREACH_COMMAND_INVALID',
      message: 'The outreach state request is invalid.',
      issues: exception.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
  }
}
