// Codex independent supervision. Pure/local only: no cloud, DB, provider or journal writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
export const stableHash = x => hash(JSON.stringify(stable(x)));
export const PIN = Object.freeze({
  sourceSha:'c0f393f863bf73bd4e65e7a94e17c073e7be021e',
  image:'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce',
  innerSha:'c60821733feb6696ac95136b49294078513e865f50cc969ea81a459a418d5abb',
  outerSha:'aeee733ad28df2e0a90dc81ab0b935aee022b9282ab3ee4750716fbb5cf2c1e8',
  readbackSha:'713b761d129f33cd95f23ca0e87831f182a156141affc30bd102f0af30d21583',
  journalSha:'8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5',
  taskArn:'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/e69540e42007496bb057c7bd9d023a37',
  taskDefinition:'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case14-sdk-read-20261004:1',
  family:'capiro-dev-meri-c2-case14-sdk-read-20261004',
  tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',clientId:'41f9ec63-3963-479f-b747-59a3767ef44b',
  candidateId:'6f4545a1-dcd5-5eba-8606-db2043b238ac',fixtureInstanceId:'dee4e90e-8e91-4782-9488-10b8e52a2146',
});
const READBACK_SHA='713b761d129f33cd95f23ca0e87831f182a156141affc30bd102f0af30d21583';

export function qualifySdk(p, normalizeDefinition) {
  assert.equal(hash(p.innerBytes),PIN.innerSha);assert.equal(hash(p.outerBytes),PIN.outerSha);
  assert.equal(hash(p.sdkBytes),READBACK_SHA);
  const sdk=JSON.parse(p.sdkBytes);
  assert.equal(sdk.kind,'case14-ordinary-embedding-sdk-readback');
  assert.equal(sdk.status,'SDK_CONFIGURATION_READ_NO_PROVIDER_DISPATCH');
  assert.equal(sdk.sourceSha,PIN.sourceSha);
  assert.deepEqual(sdk.metadata,{provider:'aws-bedrock',model:'amazon.titan-embed-text-v2:0',modelVersion:'v2',dimensions:1024});
  assert.equal(sdk.region,'us-east-1');assert.equal(sdk.maxAttempts,3);assert.equal(sdk.retryMode,'standard');
  assert.equal(sdk.useFipsEndpoint,false);assert.equal(sdk.useDualstackEndpoint,false);
  assert.deepEqual(sdk.overrideKeys,[]);assert.equal(sdk.explicitEndpointConfigured,false);
  for(const k of ['providerCalls','databaseCalls','candidateCreations','reviewDecisions','recallSubmissions'])assert.equal(sdk[k],0);
  assert.equal(sdk.acceptanceAuthority,false);
  for(const v of [p.result,p.cleanup,p.start]){
    assert.equal(v.taskArn,PIN.taskArn);assert.equal(v.taskDefinition,PIN.taskDefinition);
  }
  assert.equal(p.registered.taskDefinition,PIN.taskDefinition);
  for(const v of [p.result,p.start,p.intent])assert.equal(v.scriptSha256,PIN.innerSha);
  assert.equal(p.result.image,PIN.image);assert.equal(p.result.exitCode,0);assert.equal(p.result.providerCalls,0);
  assert.equal(p.result.fixtureScope,'EXACT_API_PUBLIC_ENV_SDK_READ_ONLY');
  assert.equal(p.intent.serviceRevision,523);assert.equal(p.intent.sourceSha,PIN.sourceSha);
  assert.equal(p.intent.providerSecrets,0);assert.equal(p.intent.workloadTaskRole,null);
  assert.equal(p.intent.allowedMutation,'NONE_READ_ONLY_SDK_CONFIGURATION');
  assert.equal(p.cleanup.taskStopped,true);assert.equal(p.cleanup.status,'INACTIVE');
  assert.equal(p.cleanup.cleanupComplete,true);assert.deepEqual(p.cleanup.cleanupErrors,[]);
  const begin=p.result.receipts.filter(x=>x.phase==='BEGIN');
  const end=p.result.receipts.filter(x=>x.phase==='END');
  const chunks=p.result.receipts.filter(x=>x.phase==='CHUNK');
  assert.equal(begin.length,1);assert.equal(end.length,1);assert.equal(chunks.length,1);
  assert.equal(p.result.receipts.length,3);assert.deepEqual({...begin[0],phase:'END'},end[0]);
  assert.deepEqual(p.transport,begin[0]);assert.equal(begin[0].chunks,1);assert.equal(chunks[0].index,0);
  const wire=Buffer.from(chunks[0].data,'base64');assert.ok(wire.equals(p.sdkBytes));
  assert.equal(begin[0].sha256,READBACK_SHA);assert.equal(begin[0].bytes,wire.length);
  assert.equal(p.definition.family,PIN.family);assert.ok(!p.definition.taskRoleArn);
  assert.equal(p.definition.containerDefinitions.length,1);const c=p.definition.containerDefinitions[0];
  assert.equal(c.image,PIN.image);assert.deepEqual(c.secrets,[]);assert.ok(!c.environmentFiles?.length);
  assert.deepEqual(c.entryPoint,['/usr/bin/dumb-init','--','node','--input-type=module','-e']);
  assert.deepEqual(c.command,[p.innerBytes.toString('utf8')]);
  const env=new Map(c.environment.map(x=>[x.name,x.value]));assert.equal(env.size,c.environment.length);
  assert.equal(env.get('RELEASE_SHA'),PIN.sourceSha);assert.equal(env.get('GIT_SHA'),PIN.sourceSha);
  assert.equal(env.get('AWS_REGION_DEFAULT'),'us-east-1');
  for(const key of ['AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_BEDROCK_RUNTIME','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_PROFILE',
    'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','DATABASE_URL','DB_PASSWORD','OPENAI_API_KEY'])assert.ok(!env.get(key));
  assert.equal(p.registration.family,PIN.family);assert.deepEqual(p.registration.previousDefinitions,[]);
  assert.equal(p.definition.tags.filter(t=>t.key==='MeriC2RegistrationOwner').length,1);
  assert.equal(p.definition.tags.find(t=>t.key==='MeriC2RegistrationOwner').value,p.registration.registrationMarker);
  assert.equal(hash(JSON.stringify(normalizeDefinition(p.definition))),p.registration.definitionSha256);
  assert.equal(p.request.cluster,'capiro-dev');assert.equal(p.request.taskDefinition,PIN.taskDefinition);
  assert.equal(p.request.count,1);assert.equal(p.request.launchType,'FARGATE');
  assert.ok(!p.request.overrides);assert.ok(p.request.startedBy.startsWith('meri-c2-receipt-'));
  assert.equal(p.journalPreserved.unchanged,true);assert.equal(p.journalPreserved.sha256,PIN.journalSha);
  assert.equal(hash(p.journalBytes),PIN.journalSha);assert.equal(p.journalBytes.toString('utf8').trim().split('\n').length,24);
  const times=[p.intent.at,p.start.at,sdk.observedAt,p.result.at,p.cleanup.at].map(Date.parse);
  assert.ok(times.every(Number.isFinite));for(let i=1;i<times.length;i++)assert.ok(times[i]>=times[i-1]);
  assert.ok(times.at(-1)-times[0]<8*60000);
  return {status:'PASS_RETAINED_SDK_EVIDENCE',sdk,taskArn:PIN.taskArn,taskDefinition:PIN.taskDefinition,
    readbackSha256:READBACK_SHA,cloudReobservation:false,
    limitation:'Full raw task and registered-definition readbacks were asserted by the pinned launcher but not retained; this verifies retained receipts, definition input, source, transport and cleanup joins.'};
}

export function fixedPayloads() {
  const key=`meri-foundation-20260928:${PIN.fixtureInstanceId}:MEM-PROPOSAL-14`;
  const value='Synthetic Aster candidate for approval';
  const openaiInput=`${key}: ${value}`,titanInput=`${key} Memory: ${value}`;
  const openaiBody=JSON.stringify({model:'text-embedding-3-small',input:openaiInput});
  const titanBody=JSON.stringify({inputText:titanInput,dimensions:1024,normalize:true});
  return {key,value,openai:{inputBytes:Buffer.byteLength(openaiInput),bodyBytes:Buffer.byteLength(openaiBody),bodySha256:hash(openaiBody)},
    titan:{inputBytes:Buffer.byteLength(titanInput),bodyBytes:Buffer.byteLength(titanBody),bodySha256:hash(titanBody),projectionTextSha256:hash(titanInput)}};
}

export function proposedEnvelope(prices,sdk,{windowMs,concurrentScheduledProjectionTasks}) {
  assert.ok(Number.isSafeInteger(windowMs)&&windowMs>0&&windowMs<=900000);
  assert.equal(concurrentScheduledProjectionTasks,0);
  assert.equal(sdk.maxAttempts,3);assert.equal(sdk.retryMode,'standard');assert.equal(sdk.region,'us-east-1');
  assert.equal(prices.kind,'official_embedding_price_readback');assert.equal(prices.providerCalls,0);
  assert.equal(prices.openai.model,'text-embedding-3-small');assert.equal(prices.openai.usdPerMillionTokens,0.02);
  const candidates=prices.aws.products.filter(p=>p.product.sku==='EDNQYEHQ3XQ8N7EY');assert.equal(candidates.length,1);
  const p=candidates[0];assert.equal(p.product.attributes.regionCode,'us-east-1');
  assert.equal(p.product.attributes.feature,'On-demand Inference');assert.equal(p.product.attributes.operation,'InvokeModelInference');
  const terms=Object.values(p.terms.OnDemand);assert.equal(terms.length,1);
  const dimensions=Object.values(terms[0].priceDimensions);assert.equal(dimensions.length,1);
  assert.equal(dimensions[0].unit,'1K tokens');assert.equal(dimensions[0].pricePerUnit.USD,'0.0000200000');
  const payloads=fixedPayloads();assert.equal(payloads.openai.bodyBytes,162);assert.equal(payloads.titan.bodyBytes,175);
  const inputMicrosPerMillion=20000;
  const charge=tokens=>Math.ceil(tokens*inputMicrosPerMillion/1000000);
  return {status:'PROPOSAL_NOT_ADMISSION',windowMs,payloads,scope:'ONE_ORDINARY_APPROVAL_FAST_PATH_WITH_NO_CONCURRENT_PROJECTION_WRITER',
    openaiNativeFetchInvocations:1,titanMaxSdkAttempts:3,
    conservativeTokenMethod:'Use serialized UTF8 body bytes as an input-token ceiling, pending explicit approval-unit/transport review; vector output is not output text tokens.',
    provisionalTokenCeilings:{openai:162,titanPerAttempt:175},
    provisionalPriceArithmeticMicros:charge(162)+3*charge(175),
    inputMicrosPerMillion,approvalEnvelopeMicros:1000000,recallCeilingMicros:14000000,combinedHoldMicros:15000000,
    chargeClassification:'CONSERVATIVE_APPROVAL_ENVELOPE_RETAINED_NOT_BILLED_ACTUAL',approvalEnvelopeRefundAllowed:false,
    approvalActualCostMicros:null,liveAdmission:false,
    prerequisites:['Fresh exact service/image/provider configuration and 15-minute deadline bound to one captureRunId',
      'Current writer census and schedule proof excluding active or newly admitted nightly/manual projection within the window',
      'Reviewed finite request/retry/unit contract for ordinary approval, including the direct Node fetch path',
      'Native aggregate capability atomically reserves combined15USD BEFORE approval and retains1USD irrespective of unmeasured approval usage',
      'Recall native qualification and receipt enforce14USD and cannot spend approval portion',
      'Postapproval exact canonical owner + completed outbox + institutional vector + legacy vector proof before closeout; unknowns remain unresolved'],
    permanentFixtureLifetimeClaim:false,acceptanceAuthority:false};
}
