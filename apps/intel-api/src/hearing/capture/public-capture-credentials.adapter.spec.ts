import { PublicCaptureCredentialsAdapter } from './public-capture-credentials.adapter.js';
describe('PublicCaptureCredentialsAdapter',()=>{
  const original=process.env.DEEPGRAM_API_KEY;
  afterEach(()=>{ if(original === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY=original; });
  it('returns only the platform credential',async()=>{ process.env.DEEPGRAM_API_KEY=' platform-key ';
    await expect(new PublicCaptureCredentialsAdapter().resolve()).resolves.toEqual({apiKey:'platform-key',billingMode:'PLATFORM_SHARED_PUBLIC_CAPTURE',source:'PLATFORM_SECRET'}); });
  it('rejects an unset key',async()=>{ delete process.env.DEEPGRAM_API_KEY; await expect(new PublicCaptureCredentialsAdapter().resolve()).rejects.toThrow('DEEPGRAM_API_KEY'); });
});
