import { assertResilienceReceipt } from '../../../../scripts/engagement-phase3-resilience-contract.mjs';
const task='11111111-1111-4111-8111-111111111111';
const ids=['ordinary-429','ordinary-500','ordinary-502','ordinary-503','ordinary-504','malformed_json','partial_response','reset','slow-timeout','safe-write-retry-no-duplicate','database-after-boot-recovery','database-unavailable-at-boot','auth-upstream-unavailable','stream-interruption'];
const response=(status,body,preview=false)=>({kind:'http',status,body,service:preview?'engagement-api':null});
const make=()=>({marker:'ENGAGEMENT_PHASE3_RESILIENCE_COMPLETE',cases:15,results:[...ids.map(id=>id==='safe-write-retry-no-duplicate'?{id,retriedTask:{body:{id:task}}}:{id}),{id:'auth-rejection-then-recovery',taskId:task,requestCount:4,path:'/api/engagement/tasks',rejected:{main:response(401,{statusCode:401,message:'Missing bearer token'}),preview:response(401,{statusCode:401,message:'Missing bearer token'},true)},recovered:{main:response(200,[{id:task}]),preview:response(200,[{id:task}],true)}}]});
const cases=[];
for(const [field,values] of [['sourcePolicyOnly',['true',1,{},[]]],['nativeProofPerformed',['false',0,null]]])for(const value of values){const input=make();input[field]=value;let accepted=true;try{assertResilienceReceipt(input)}catch{accepted=false}cases.push({field,value,accepted});}
console.log(JSON.stringify({source:'b051e32392cfd18b1bfd4a159c500ae8c3ac0680',cases},null,2));
