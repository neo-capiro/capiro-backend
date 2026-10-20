import { BadRequestException, RequestTimeoutException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { FloridaCurrentAuthorityControl } from './florida-current-authority.service.js';

export interface RetainedFloridaRequestControl extends FloridaCurrentAuthorityControl {
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

/** A bounded response-lifetime latch; it does not physically cancel database I/O. */
export function retainedFloridaRequest(req: Request, res: Response): RetainedFloridaRequestControl {
  const startedAt = Date.now();
  const supplied = req.headers['x-meri-deadline-at'];
  if (supplied !== undefined && (typeof supplied !== 'string' || !/^[0-9]{1,16}$/.test(supplied) ||
      !Number.isSafeInteger(Number(supplied)))) throw new BadRequestException('Invalid retained Florida deadline');
  const deadlineMs = Math.min(startedAt + 30_000, supplied === undefined ? Infinity : Number(supplied));
  let cancelled = Boolean(req.aborted || res.destroyed || res.writableFinished);
  let closed = false;
  let running = false;
  let rejectPending: ((error: RequestTimeoutException) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = () => new RequestTimeoutException('Retained Florida request no longer active');
  const abort = () => { cancelled = true; rejectPending?.(timeout()); };
  req.once('aborted', abort);
  res.once('close', abort);
  const control: RetainedFloridaRequestControl = {
    deadlineMs,
    assertActive() {
      if (closed || cancelled || req.aborted || res.destroyed || res.writableFinished || Date.now() >= deadlineMs) throw timeout();
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      control.assertActive();
      if (running) throw timeout();
      running = true;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => { control.assertActive(); return operation(); }),
          new Promise<never>((_resolve, reject) => {
            rejectPending = reject;
            timer = setTimeout(abort, Math.max(1, deadlineMs - Date.now()));
          }),
        ]);
        // A delayed timer must not allow a result that settled after the cutoff.
        control.assertActive();
        return result;
      } catch (error) {
        control.assertActive();
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        rejectPending = undefined;
        running = false;
      }
    },
    close() {
      closed = true;
      rejectPending?.(timeout());
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    },
  };
  return control;
}
