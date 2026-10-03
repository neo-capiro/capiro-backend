import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const tenantId='f2d6cf8f-057c-479a-8110-62fe5086d43f',userId='b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clientId='41f9ec63-3963-479f-b747-59a3767ef44b',conversationId='f493355c-ee97-44a1-a0b0-e05e7b104b59',
  turnId='8c8e1c76-c7b2-4c98-9fc4-ac433be980a0';
const hash=b=>createHash('sha256').update(b).digest('hex');
const emit=async v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE01_RECEIPT_DIAGNOSTIC '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const {PrismaClient}=require('@prisma/client');const prisma=new PrismaClient({log:[]});
try{
  assert.equal(process.env.RELEASE_SHA,'5b086a6b47ffce5aa1b93bfe38f9c7b96e297642');
  const result=await prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10s'");
    await tx.$queryRaw`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
    const conversations=await tx.clioConversation.findMany({where:{id:conversationId,tenantId,userId,clientId,archivedAt:null},select:{id:true,tenantId:true,userId:true,clientId:true,metadata:true}});
    assert.equal(conversations.length,1);
    const ormMessages=await tx.clioMessage.findMany({where:{conversationId,tenantId,userId,clientId},orderBy:{createdAt:'asc'},take:3,
      select:{id:true,tenantId:true,userId:true,clientId:true,conversationId:true,role:true,body:true,metadata:true,createdAt:true}});
    assert.equal(ormMessages.length,2);assert.equal(ormMessages.filter(m=>m.role==='user'&&m.id===turnId).length,1);
    assert.equal(ormMessages.filter(m=>m.role==='assistant').length,1);
    const rawMessages=await tx.$queryRaw`SELECT id::text,metadata_jsonb::text AS metadata_text FROM clio_messages WHERE tenant_id=${tenantId}::uuid AND user_id=${userId}::uuid AND client_id=${clientId}::uuid AND conversation_id=${conversationId}::uuid ORDER BY created_at`;
    assert.equal(rawMessages.length,2);
    const packets=await tx.contextPacket.findMany({where:{tenantId,OR:[{ref:{path:['conversationId'],equals:conversationId}},{ref:{path:['captureTurnId'],equals:turnId}}]},take:101,
      select:{id:true,tenantId:true,effectiveTenantId:true,userId:true,actorUserId:true,clientId:true,surface:true,ref:true,modelPolicy:true,packetVersion:true,traceId:true,createdAt:true}});
    assert.ok(packets.length>0&&packets.length<=100);
    for(const packet of packets){
      assert.equal(packet.tenantId,tenantId);assert.equal(packet.effectiveTenantId,tenantId);
      assert.equal(packet.userId,userId);assert.equal(packet.clientId,clientId);
      assert.ok([1,2].includes(packet.packetVersion));
      if(packet.packetVersion===2)assert.equal(packet.actorUserId,userId);
      assert.equal(packet.surface,'chat');assert.equal(packet.ref?.conversationId,conversationId);
    }
    const rawPackets=await tx.$queryRaw`SELECT id::text,ref_jsonb::text AS ref_text,model_policy_jsonb::text AS model_policy_text FROM context_packet WHERE tenant_id=${tenantId}::uuid AND (ref_jsonb->>'conversationId'=${conversationId} OR ref_jsonb->>'captureTurnId'=${turnId}) ORDER BY created_at LIMIT 101`;
    assert.equal(rawPackets.length,packets.length);assert.deepEqual(rawPackets.map(p=>p.id).sort(),packets.map(p=>p.id).sort());
    return {status:'READ_ONLY_RAW_AND_PRISMA_DIAGNOSTIC',captureRunId:'bd35c0f4-1604-4371-b7e9-a1338369e53f',tenantId,userId,clientId,conversationId,turnId,
      sourceSha:process.env.RELEASE_SHA,conversation:conversations[0],ormMessages,rawMessages,packets,rawPackets,
      businessWrites:0,providerCalls:0,readOnlyTransaction:true,acceptanceAuthority:false,observedAt:new Date().toISOString()};
  },{timeout:30000});
  const bytes=Buffer.from(JSON.stringify(result)+'\n');assert.ok(bytes.length<1024*1024);
  assert.equal(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}|\bsk_(?:live|test)_[A-Za-z0-9]{16,}/u.test(bytes.toString()),false);
  const encoded=bytes.toString('base64'),count=Math.ceil(encoded.length/6000);
  const meta={sha256:hash(bytes),bytes:bytes.length,chunks:count};
  await emit({phase:'BEGIN',...meta});
  for(let i=0;i<count;i++)await emit({phase:'CHUNK',index:i,data:encoded.slice(i*6000,(i+1)*6000)});
  await emit({phase:'END',...meta});
}catch(e){await emit({phase:'FAILURE',errorClass:e?.name??'Error',messageSha256:hash(String(e?.message??''))});process.exitCode=1;}
finally{await prisma.$disconnect();}
