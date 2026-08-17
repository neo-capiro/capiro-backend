import { Injectable, type LoggerService } from '@nestjs/common';

function emit(level: string, message: unknown, context?: string): void {
  const payload = {
    timestamp: new Date().toISOString(),
    service: 'defense-api',
    level,
    context: context || undefined,
    message: typeof message === 'string' ? message : JSON.stringify(message),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

@Injectable()
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    emit('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    emit('error', trace ? { message, trace } : message, context);
  }

  warn(message: unknown, context?: string): void {
    emit('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    emit('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    emit('verbose', message, context);
  }
}
