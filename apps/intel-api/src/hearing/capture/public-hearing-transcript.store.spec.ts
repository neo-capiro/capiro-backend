import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';
describe('PublicHearingTranscriptStore',()=>{
  it('uses the replay key and marks the segment after a gap',async()=>{ const execute=jest.fn().mockResolvedValue(1); const store=new PublicHearingTranscriptStore({$executeRawUnsafe:execute} as never);
    await store.appendGap({captureId:'c',hearingId:'h',gap:{startMs:0,endMs:1500,reason:'MEDIA_DISCONNECT'}});
    await store.appendFinal({captureId:'c',hearingId:'h',segment:{startMs:1500,endMs:2000,text:'hello'}});
    expect(execute.mock.calls[1][0]).toContain('ON CONFLICT (capture_id,start_ms,end_ms) DO NOTHING'); expect(execute.mock.calls[1].at(-1)).toBe(true); });
});
