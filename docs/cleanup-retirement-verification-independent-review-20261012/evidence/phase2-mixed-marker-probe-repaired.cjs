const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),path=require('node:path');
const out='docs/cleanup-retirement-verification-independent-review-20261012/evidence/';
const source=fs.readFileSync('scripts/verify-engagement-phase2-code.sh','utf8');
const begin=source.indexOf('# PHASE2_MODE_PLAN_BEGIN\n'),end=source.indexOf('# PHASE2_MODE_PLAN_END',begin),mode=source.slice(begin+'# PHASE2_MODE_PLAN_BEGIN\n'.length,end);
const g=source.indexOf('phase1_gate() {'),ge=source.indexOf('\n}\n\ngate() {',g),gate=source.slice(g,ge+2);assert(begin>=0&&end>begin&&g>=0&&ge>g);
const backend='[engagement-phase1] BACKEND COMPLETE',frontend='[engagement-phase1] FRONTEND COMPLETE',full='ENGAGEMENT_PHASE1_DB_FREE_COMPLETE';
const cases=[
 ['selected only',backend,0,0,0],['foreign only',full,0,0,1],['both full and selected',backend+'\n'+full,0,0,1],
 ['both sibling and selected',backend+'\n'+frontend,0,0,1],['foreign failed plus selected',backend+'\nENGAGEMENT_PHASE1_DB_FREE_FAILED',0,0,1],
 ['selected failure plus complete',backend+'\n[engagement-phase1] BACKEND FAILED',0,0,1],['child exit1',backend,1,0,1],['tee exit1',backend,0,1,1],
];
const results=[];
for(const [label,log,childStatus,teeStatus,expected]of cases){
 const logPath=path.resolve(out,'phase2-repaired-marker-'+results.length+'.synthetic.log');
 const code='set -uo pipefail\n'+mode+'\nTIMEOUT_BIN=fake_child\nfake_child() { printf "%s\\n" "$FAKE_LOG"; return "$FAKE_STATUS"; }\ntee() { /usr/bin/tee "$@"; return "$FAKE_TEE_STATUS"; }\n'+gate+'\nphase1_gate "$FIXTURE_LOG" 100 refusing-fixture-child; status=$?; printf "\\nGATE_STATUS=%s\\n" "$status"; exit 0\n';
 const r=cp.spawnSync('/bin/bash',['--noprofile','--norc','-c',code,'isolated-mode-fixture','--run','--backend-only'],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',FAKE_LOG:log,FAKE_STATUS:String(childStatus),FAKE_TEE_STATUS:String(teeStatus),FIXTURE_LOG:logPath}});
 assert.ifError(r.error);assert.equal(r.status,0,r.stderr);const actual=Number(r.stdout.match(/GATE_STATUS=(\d+)/)[1]);
 results.push({label,childStatus,teeStatus,expectedGateStatus:expected,actualGateStatus:actual,correct:actual===expected,stdout:r.stdout,stderr:r.stderr});
}
const result={source:'e35d37ec080bbfbc5fccc0affe543af5b31fc1e2',results,failures:results.filter(r=>!r.correct),actualQualificationVerifierProviderNativeEngineCalls:0,extractedShellModeAndGateOnly:true,acceptance:false};
fs.writeFileSync(out+'phase2-repaired-marker-red.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));if(result.failures.length)process.exitCode=1;
