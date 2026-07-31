import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, type Subscription } from 'rxjs';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';

/**
 * Buffers normal HTTP handler results until the request-local context boundary is
 * known to be clean. A swallowed required persistence error therefore cannot
 * release a memo, district brief, outreach draft, or other audited deliverable.
 */
@Injectable()
export class ContextPersistenceBoundaryInterceptor implements NestInterceptor {
  constructor(private readonly boundary: ContextPersistenceBoundaryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      this.boundary.run(() => {
        const buffered: unknown[] = [];
        try {
          subscription = next.handle().subscribe({
            next: (value) => buffered.push(value),
            error: (error) => subscriber.error(error),
            complete: () => {
              const failure = this.boundary.failure();
              if (failure) {
                subscriber.error(failure);
                return;
              }
              for (const value of buffered) subscriber.next(value);
              subscriber.complete();
            },
          });
        } catch (error) {
          subscriber.error(error);
        }
      });
      return () => subscription?.unsubscribe();
    });
  }
}
