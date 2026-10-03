import { readFileSync } from 'node:fs';
import { root,ctx,save,need,withAuth } from './auth-preflight.mjs';
import { prepareMemoryReadCase } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/memory-read-protocol.mjs';
import { inspectMemoryReadServerBudget } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/memory-read-budget-authority.mjs';
import { nativeMeriCaptureHeaders } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/lib/native-http.mjs';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const ids=process.argv.slice(2);need(ids.length>0&&ids.every(id=>['01','02','03','04','05'].includes(id)),'EXACT_SAVED_CASE_REQUIRED');
await withAuth(async({refresh})=>{
  for(const id of ids){
    const label='case'+id,config=read(label+'-config.json'),plan=prepareMemoryReadCase(config),lock=read(label+'-operator-lock.json'),usage=read(label+'-usage.json');
    const fetchOwned=async(suffix)=>{
      const r=await fetch('https://os.capiro.ai/api/clio/conversations/'+config.conversationId+suffix,{headers:nativeMeriCaptureHeaders(await refresh(),ctx.tenantSlug),redirect:'error',signal:AbortSignal.timeout(30000)});
      need(r.status===200&&r.headers.get('x-capiro-release-sha')===config.apiSha,'OWNED_READBACK_FAILED_'+r.status);
      return r.json();
    };
    const conversation=await fetchOwned(''),messages=await fetchOwned('/messages');
    const verified=inspectMemoryReadServerBudget(conversation,messages,plan,lock.reservation,{terminal:true});
    need(verified.ledgerSha256===usage.ledgerSha256&&verified.envelopeSha256===usage.envelopeSha256&&verified.chargedCostMicros===usage.chargedCostMicros,'TERMINAL_READBACK_CHANGED');
    save(label+'-terminal-readback.json',{kind:'fresh_authenticated_terminal_readback',fetchedAt:new Date().toISOString(),apiSha:config.apiSha,conversation,messages,verified});
    console.log(JSON.stringify({caseId:id,status:'TERMINAL_LEDGER_AND_MESSAGES_REVERIFIED',costMicros:verified.chargedCostMicros,attempts:conversation.metadata.syntheticReadProviderBudget.ledger.attempts.length}));
  }
});
save('readback-'+ids.join('-')+'-cleanup.json',{at:new Date().toISOString(),sessionRevoked:true});
