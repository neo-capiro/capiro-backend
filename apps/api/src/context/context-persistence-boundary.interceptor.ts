import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, type Subscription } from 'rxjs';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';

/**
 * Checks the request-local persistence boundary before forwarding any normal HTTP
 * value. Promise-backed Nest handlers emit only after their generator finishes,
 * so a swallowed required persistence failure is converted back into the exact
 * bounded error before a memo, district brief, outreach draft, or other audited
 * result reaches the response adapter.
 */
@Injectable()
export class ContextPersistenceBoundaryInterceptor implements NestInterceptor {
  constructor(private readonly boundary: ContextPersistenceBoundaryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      this.boundary.run(() => {
        try {
          subscription = next.handle().subscribe({
            next: (value) => {
              const failure = this.boundary.failure();
              if (failure) {
                subscriber.error(failure);
                subscription?.unsubscribe();
                return;
              }
              subscriber.next(value);
            },
            error: (error) => subscriber.error(error),
            complete: () => {
              const failure = this.boundary.failure();
              if (failure) subscriber.error(failure);
              else subscriber.complete();
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
