import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const data = value=>`data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
const nest=data('export class Logger{}; export class ServiceUnavailableException extends Error{}; export class BadRequestException extends Error{};export class ConflictException extends Error{};export function Injectable(){return x=>x;}');
const config=data('export class ConfigService{}');
const types=data("export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;export const SHA256=/^[a-f0-9]{64}$/;export const SAFE_FAILURES={};export const digest=JSON.stringify;");
let source=await readFile(new URL('../src/meri/strategy-context-plane.client.ts',import.meta.url),'utf8');
source=source.replace('@Injectable()','').replaceAll("'@nestjs/common'",JSON.stringify(nest))
  .replace("'@nestjs/config'",JSON.stringify(config)).replace("'./objective-generation.types.js'",JSON.stringify(types));
const {StrategyContextPlaneClient}=await import(data(stripTypeScriptTypes(source,{mode:'transform'})));
const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const request={tenantId:id(1),clerkUserId:'synthetic',clientId:id(2),mode:'draft',generationRequestId:id(3),
  generationType:'coalition',objective:{objectiveId:id(4),objectiveVersion:2}};
const evidence={ref:`context-fact:${id(5)}:${'a'.repeat(64)}`,sourceId:id(5),asOfMs:Date.now()-1000,scope:'client',clientId:id(2),
  reviewState:'accepted',kind:'context_fact',title:'Allowed brief',text:'Allowed fact',locator:'section:1',version:'a'.repeat(64)};
function body(){return {tenantId:request.tenantId,clerkUserId:request.clerkUserId,requestId:request.generationRequestId,
  source:{clientId:request.clientId,...request.objective},complete:true,checkedAt:new Date().toISOString(),evidence:[{...evidence}]};}
async function run(value,check){
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(...args)=>{calls.push(args);return {ok:true,json:async()=>value};};
  try {const client=new StrategyContextPlaneClient({get:key=>key==='INTERNAL_SERVICE_SECRET'?'synthetic':undefined});
    await check(()=>client.readObjectiveEvidence(request),calls);
  }finally{globalThis.fetch=original;}
}
test('citation read uses the existing read-only objective check and retains exact authorized metadata',async()=>{
  await run(body(),async(read,calls)=>{assert.deepEqual(await read(),[evidence]);assert.equal(calls.length,1);
    assert.match(calls[0][0],/\/objective-check$/);assert.doesNotMatch(calls[0][0],/compile|commands|materializ/);});
});
test('partial, stale, future, wrong actor and foreign source observations fail closed',async()=>{
  for(const mutate of [v=>v.complete=false,v=>v.checkedAt='2020-01-01T00:00:00Z',v=>v.checkedAt='2099-01-01T00:00:00Z',
    v=>v.clerkUserId='foreign',v=>v.evidence[0].clientId=id(99),v=>v.evidence[0].ref=v.evidence[0].ref.replace('context-fact','governed-memory'),
    v=>v.evidence[0].version='b'.repeat(64)]) {const value=body();mutate(value);await run(value,async read=>assert.rejects(read));}
});
test('authorized governed memory can retain its owner-supported body limit before display projection',async()=>{
  const value=body(); Object.assign(value.evidence[0],{kind:'governed_memory',ref:evidence.ref.replace('context-fact','governed-memory'),text:'A'.repeat(50000)});
  await run(value,async read=>assert.equal((await read())[0].text.length,50000));
  value.evidence[0].text=Array.from({length:50},()=> 'A'.repeat(4000)).join('\n\n');
  await run(value,async read=>assert.equal((await read())[0].text.length,200098));
  value.evidence[0].text+='A'; await run(value,async read=>assert.rejects(read));
});
