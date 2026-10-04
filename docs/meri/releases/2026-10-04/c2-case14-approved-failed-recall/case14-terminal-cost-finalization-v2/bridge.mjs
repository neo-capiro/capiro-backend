import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {consumeCase14TerminalCostAuthority} from './authority.mjs';
import {hash} from './predicate.mjs';
const PYTHON='C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const LIVE='C:/dev/main/outputs/meri-fresh-20261003';
const need=(v,label)=>{if(!v)throw Error('CASE14_COST_NATIVE_BRIDGE_REJECTED:'+label);};
function invoke(script,request){
 need(process.platform==='win32','Windows required');
 const result=spawnSync(PYTHON,['-I',fileURLToPath(new URL(script,import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,shell:false,timeout:15000,maxBuffer:2*1024*1024});
 need(!result.error&&result.status===0,'native failure');const response=JSON.parse(result.stdout);need(response.ok===true,'native response');return response;
}
function sourceCheck(value){for(const p of value.sourcePins){const b=readFileSync(p.path);need(b.length===p.bytes&&hash(b)===p.sha256,'source drift');}}
const event=proof=>({kind:'reconcile_terminal',caseId:proof.caseId,captureRunId:proof.captureRunId,reservationId:proof.reservationId,proof});
export function dryRunCase14TerminalCost(capability){
 const value=consumeCase14TerminalCostAuthority(capability);sourceCheck(value);
 return invoke('./dry-run-driver.py',{proof:value.proof,checkpoint:value.checkpoint});
}
/** Lead-only single append to the ORIGINAL native root/checkpoint. No adoption. */
export function reconcileCase14TerminalCost(capability,{invocation}={}){
 need(invocation==='RECONCILE_FAILED_CASE14_PROVIDER_COST_ONCE','invocation');
 const value=consumeCase14TerminalCostAuthority(capability);sourceCheck(value);
 need(value.checkpoint.kind==='meri-fresh-capture-spend-checkpoint'&&value.checkpoint.state.root===resolve(LIVE)&&value.checkpoint.snapshot.eventCount===25,'original checkpoint');
 // Native exact identities/content/prefix and exclusive writer-open remain the fence.
 const response=invoke('./native/windows-capture-spend.py',{op:'fresh_reconcile_terminal',root:resolve(LIVE),state:value.checkpoint.state,event:event(value.proof)});
 need(response.state.root===resolve(LIVE),'native root');
 return{kind:'meri-fresh-capture-spend-checkpoint',version:1,state:response.state,snapshot:response.snapshot};
}
