import { PublicCaptureQueueAdapter, type CaptureQueueScheduler } from './public-capture-queue.adapter.js';
describe('PublicCaptureQueueAdapter',()=>{
  it('deduplicates until marked done',async()=>{ const q=new PublicCaptureQueueAdapter(); const job={dedupeKey:'k',captureId:'c',hearingId:'h',mustReresolve:true as const};
    expect((await q.enqueue(job)).enqueued).toBe(true); expect((await q.enqueue(job)).enqueued).toBe(false); q.markDone('k'); expect((await q.enqueue(job)).enqueued).toBe(true); });
  it('caps scheduled delay with an injected scheduler',async()=>{ let callback=()=>{}; let delay=-1; const scheduler:CaptureQueueScheduler={setTimeout:(cb,ms)=>{callback=cb;delay=ms;return 1;},clearTimeout:()=>{}};
    const q=new PublicCaptureQueueAdapter(()=>new Date(0),scheduler,1000); const heard=jest.fn(); q.events.on('preflight',heard);
    await q.schedulePreflight({dedupeKey:'p',hearingId:'h',dueAt:new Date(86_400_000)}); expect(delay).toBe(1000); callback(); expect(heard).toHaveBeenCalledWith({version:1,hearingId:'h'}); });
});
