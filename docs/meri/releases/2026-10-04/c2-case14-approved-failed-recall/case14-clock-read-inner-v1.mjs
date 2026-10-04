import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const source='c0f393f863bf73bd4e65e7a94e17c073e7be021e',tenant='f2d6cf8f-057c-479a-8110-62fe5086d43f',user='fb218bf5-2674-4ced-bca3-7a5d0c01592f';
const conversation='88603ac2-bfbf-42dc-9e3b-85e4bea173b8',policy='82f530b5-a36f-4e90-81ac-fda4840034ca',request='2371998a-27c6-4e2d-93c9-b7502a08f0ae',turn='d0284dec-ab0c-471c-8b17-1792a769cd2e';
const ids=['c24b6d6a-6fc7-4d7d-89fe-31aa2082d579','3c4ff2c3-4043-4406-bbb6-19b2cc6808a8'];
assert.equal(process.env.GIT_SHA,source);assert.equal(process.env.RELEASE_SHA,source);
for(const k of ['OPENAI_API_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'])assert.equal(process.env[k],undefined);
const composed=spawnSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000,maxBuffer:65536});
assert.equal(composed.status,0);assert.match(composed.stdout,/^postgresql:\/\//u);process.env.DATABASE_URL=composed.stdout.trim();
const require=createRequire('/app/apps/api/package.json'),{PrismaService}=require('/app/apps/api/dist/prisma/prisma.service.js');
const prisma=new PrismaService();
try{
 await prisma.$connect();
 const rows=await prisma.withTenantUser(tenant,user,async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000ms'");
  return tx.contextPacket.findMany({where:{tenantId:tenant,OR:[{id:{in:ids}},{ref:{path:['capturePolicyId'],equals:policy}},{ref:{path:['captureRequestId'],equals:request}},{ref:{path:['captureTurnId'],equals:turn}},{AND:[{ref:{path:['conversationId'],equals:conversation}},{createdAt:{gte:new Date(1791093201190)}}]}]},take:101,select:{id:true,tenantId:true,effectiveTenantId:true,userId:true,actorUserId:true,clientId:true,surface:true,ref:true,modelPolicy:true,packetVersion:true,traceId:true,createdAt:true}});
 },{timeoutMs:7000});
 const proof={kind:'case14-existing-context-packet-read',status:'CLOCK_PACKETS_READ_NO_PROVIDER_DISPATCH',sourceSha:source,observedAt:new Date().toISOString(),captureRunId:'5f4312a2-6aa9-4ec8-820d-5717a88402df',tenantId:tenant,userId:user,conversationId:conversation,expectedPacketIds:ids,rows,transactionReadOnly:true,providerCalls:0,databaseWrites:0,candidateCreations:0,reviewDecisions:0,recallSubmissions:0,acceptanceAuthority:false};
 const bytes=Buffer.from(JSON.stringify(proof)+'\n'),data=bytes.toString('base64'),parts=data.match(/.{1,2000}/gu)??[];
 const meta={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,chunks:parts.length};
 const emit=v=>process.stdout.write('C2_CASE14_CLOCK_READ '+JSON.stringify(v)+'\n');
 emit({phase:'BEGIN',...meta});parts.forEach((data,index)=>emit({phase:'CHUNK',index,data}));emit({phase:'END',...meta});
}finally{await prisma.$disconnect();}
