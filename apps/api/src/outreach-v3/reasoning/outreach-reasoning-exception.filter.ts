import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachReasoningError } from './outreach-reasoning.contract.js';

@Catch(OutreachReasoningError, OutreachCommandError)
export class OutreachReasoningExceptionFilter implements ExceptionFilter {
  catch(exception: OutreachReasoningError | OutreachCommandError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof OutreachReasoningError) {
      response.status(exception.httpStatus).json({
        statusCode: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        retryable: exception.retryable,
        ...(exception.safeMetadata ? { metadata: exception.safeMetadata } : {}),
      });
      return;
    }

    response.status(exception.httpStatus).json({
      statusCode: exception.httpStatus,
      code: exception.code,
      message: exception.message,
      ...(exception.safeMetadata ? { metadata: exception.safeMetadata } : {}),
    });
  }
}
