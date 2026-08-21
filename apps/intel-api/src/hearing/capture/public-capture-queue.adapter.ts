import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { PublicCaptureQueuePort } from './public-capture.orchestrator.js';

export interface CaptureQueueScheduler { setTimeout(callback:()=>void, delayMs:number): unknown; clearTimeout(handle:unknown):void }
const nativeScheduler: CaptureQueueScheduler = {
  setTimeout: (callback,delay) => setTimeout(callback,delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Phase-4-exit-sufficient in-process queue. SQS/EventBridge wiring is deployment Step 6/18. */
@Injectable()
export class PublicCaptureQueueAdapter implements PublicCaptureQueuePort {
  readonly events = new EventEmitter();
  private readonly pending = new Set<string>();
  private readonly timers = new Map<string,unknown>();
  constructor(private readonly now:()=>Date=()=>new Date(), private readonly scheduler:CaptureQueueScheduler=nativeScheduler,
    private readonly maxDelayMs=60_000) {}

  async enqueue(input:{dedupeKey:string;captureId:string;hearingId:string;mustReresolve:true}) {
    if (this.pending.has(input.dedupeKey)) return { enqueued:false };
    this.pending.add(input.dedupeKey);
    const jobId=`in-process:${input.dedupeKey}`;
    this.events.emit('capture',{version:1,captureId:input.captureId,hearingId:input.hearingId,mustReresolve:true,dedupeKey:input.dedupeKey});
    return { enqueued:true, jobId };
  }
  markDone(dedupeKey:string):void { this.pending.delete(dedupeKey); }
  async scheduleRetry(input:{dedupeKey:string;captureId:string;hearingId:string;dueAt:Date;mustReresolve:true}):Promise<void> {
    if (this.pending.has(input.dedupeKey)) return;
    this.pending.add(input.dedupeKey);
    const delay=Math.min(this.maxDelayMs,Math.max(0,input.dueAt.getTime()-this.now().getTime()));
    const handle=this.scheduler.setTimeout(()=>{ this.timers.delete(input.dedupeKey); this.pending.delete(input.dedupeKey);
      this.events.emit('capture',{version:1,captureId:input.captureId,hearingId:input.hearingId,mustReresolve:true}); },delay);
    this.timers.set(input.dedupeKey,handle);
  }
  async schedulePreflight(input:{dedupeKey:string;hearingId:string;dueAt:Date}):Promise<void> {
    if (this.pending.has(input.dedupeKey)) return;
    this.pending.add(input.dedupeKey);
    const delay=Math.min(this.maxDelayMs,Math.max(0,input.dueAt.getTime()-this.now().getTime()));
    const handle=this.scheduler.setTimeout(()=>{ this.timers.delete(input.dedupeKey); this.pending.delete(input.dedupeKey);
      this.events.emit('preflight',{version:1,hearingId:input.hearingId}); },delay);
    this.timers.set(input.dedupeKey,handle);
  }
}
