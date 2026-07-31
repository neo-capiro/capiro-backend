import { lastValueFrom, Observable, of } from 'rxjs';
import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ContextPersistenceBoundaryInterceptor } from './context-persistence-boundary.interceptor.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';

describe('Context persistence release boundary', () => {
  it('releases a normal HTTP result', async () => {
    const boundary = new ContextPersistenceBoundaryService();
    const interceptor = new ContextPersistenceBoundaryInterceptor(boundary);
    const context = { getType: () => 'http' } as unknown as ExecutionContext;
    const handler = { handle: () => of({ ok: true }) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, handler))).resolves.toEqual({
      ok: true,
    });
  });

  it('blocks a result when a required persistence error was swallowed downstream', async () => {
    const boundary = new ContextPersistenceBoundaryService();
    const interceptor = new ContextPersistenceBoundaryInterceptor(boundary);
    const context = { getType: () => 'http' } as unknown as ExecutionContext;
    const failure = new ContextPacketPersistenceError(
      'context_packet_error',
      'attempt-1',
      'outreach',
    );
    const handler = {
      handle: () =>
        new Observable((subscriber) => {
          boundary.record(failure);
          subscriber.next({ unsafe: true });
          subscriber.complete();
        }),
    } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, handler))).rejects.toBe(failure);
  });

  it('ignores ordinary optional-context failures', async () => {
    const boundary = new ContextPersistenceBoundaryService();
    const interceptor = new ContextPersistenceBoundaryInterceptor(boundary);
    const context = { getType: () => 'http' } as unknown as ExecutionContext;
    const handler = {
      handle: () =>
        new Observable((subscriber) => {
          boundary.record(new Error('optional context unavailable'));
          subscriber.next('ok');
          subscriber.complete();
        }),
    } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, handler))).resolves.toBe('ok');
  });
});
