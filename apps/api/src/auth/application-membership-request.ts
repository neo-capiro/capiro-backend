import { BadRequestException, RequestTimeoutException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApplicationMembershipControl } from './application-membership.js';

/** A request-local latch, not a claim that abort rolls back underlying I/O. */
export function applicationMembershipRequest(req: Request, res: Response): ApplicationMembershipControl & {
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
} {
  const startedAt = Date.now();
  const supplied = req.headers['x-meri-deadline-at'];
  if (supplied !== undefined && (typeof supplied !== 'string' || !/^[0-9]{1,16}$/.test(supplied) ||
      !Number.isSafeInteger(Number(supplied)))) throw new BadRequestException('Invalid request deadline');
  const deadlineMs = Math.min(startedAt + 30_000, supplied === undefined ? Infinity : Number(supplied));
  let cancelled = req.aborted || res.destroyed;
  let closed = false;
  let rejectPending: ((error: RequestTimeoutException) => void) | undefined;
  const timeout = () => new RequestTimeoutException('Membership request no longer active');
  const abort = () => { cancelled = true; rejectPending?.(timeout()); };
  const close = () => { if (!res.writableFinished) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  const control = {
    deadlineMs,
    assertActive() {
      if (closed || cancelled || req.aborted || res.destroyed || Date.now() >= deadlineMs) {
        throw timeout();
      }
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      control.assertActive();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => { control.assertActive(); return operation(); }),
          new Promise<never>((_resolve, reject) => {
            rejectPending = reject;
            timer = setTimeout(abort, Math.max(1, deadlineMs - Date.now()));
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        rejectPending = undefined;
      }
    },
    close() {
      closed = true;
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    },
  };
  return control;
}
