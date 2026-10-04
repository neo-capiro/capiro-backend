import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire('/app/apps/api/package.json');
const emit=v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE14_SDK_READ '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
try {
  assert.equal(process.env.RELEASE_SHA,'c0f393f863bf73bd4e65e7a94e17c073e7be021e');
  assert.ok(!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && !process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  const {getDefaultEmbeddingProvider}=require('/app/apps/api/dist/embeddings/embedding-provider.factory.js');
  const provider=getDefaultEmbeddingProvider();
  assert.equal(provider.metadata.provider,'aws-bedrock');
  assert.equal(provider.metadata.model,'amazon.titan-embed-text-v2:0');
  assert.equal(provider.metadata.dimensions,1024);
  const {BedrockRuntimeClient}=require('@aws-sdk/client-bedrock-runtime');
  const client=new BedrockRuntimeClient({region:provider.region});
  const maxAttempts=await client.config.maxAttempts();
  const retryMode=await client.config.retryMode();
  const region=await client.config.region();
  const overrideKeys=['AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_BEDROCK_RUNTIME','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_PROFILE'].filter(k=>process.env[k]);
  const value={kind:'case14-ordinary-embedding-sdk-readback',status:'SDK_CONFIGURATION_READ_NO_PROVIDER_DISPATCH',
    sourceSha:process.env.RELEASE_SHA,metadata:provider.metadata,region,maxAttempts,retryMode,
    useFipsEndpoint:await client.config.useFipsEndpoint(),useDualstackEndpoint:await client.config.useDualstackEndpoint(),
    overrideKeys,explicitEndpointConfigured:Boolean(client.config.endpoint),providerCalls:0,databaseCalls:0,
    candidateCreations:0,reviewDecisions:0,recallSubmissions:0,acceptanceAuthority:false,observedAt:new Date().toISOString()};
  client.destroy();
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),encoded=bytes.toString('base64');
  const meta={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,chunks:1};
  await emit({phase:'BEGIN',...meta});await emit({phase:'CHUNK',index:0,data:encoded});await emit({phase:'END',...meta});
}catch(error){await emit({phase:'FAILURE',code:'CASE14_SDK_READ_FAILED',errorClass:error.name,providerCalls:0,databaseCalls:0});process.exitCode=1;}
