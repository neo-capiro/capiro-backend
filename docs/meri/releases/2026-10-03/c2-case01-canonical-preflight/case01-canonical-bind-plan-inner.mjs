import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createCase01SetupDependencies} from './scripts/meri-case01-setup-dependencies.mjs';
import {readCase01MemoryCorpusInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs';
import {buildFixtureManifest} from '/app/evals/meri/live-v1/fixture-provisioning/manifest.mjs';
import {createCase01MemoryFixtureRuntime} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-runtime.mjs';
import {createCaptureBindingOwner} from '/app/evals/meri/live-v1/fixture-provisioning/capture-binding-owner.mjs';
import {sha256Stable} from '/app/evals/meri/live-v1/artifact-collector.mjs';

const input=JSON.parse(process.env.MERI_C2_CASE01_READ_INPUT);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let factory;
try {
  assert.equal(process.env.RELEASE_SHA,'f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f');
  assert.equal(input.confirmation,'READ_EXISTING_CASE01_CANONICAL_BINDING_ONLY');
  assert.equal(input.ctx.tenantId,'f2d6cf8f-057c-479a-8110-62fe5086d43f');
  assert.equal(input.ctx.userId,'b1f758fc-17bd-40f8-bef2-fa2d2380300f');
  assert.equal(input.clientId,'41f9ec63-3963-479f-b747-59a3767ef44b');
  assert.match(input.prospectiveCaptureRunId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  factory=await createCase01SetupDependencies();
  const result=await factory.runWithTenant(input.ctx,async()=>{
    let actualProof;
    const sourceAuthority={qualifyInTx:async(tx,ctx,scope)=>{
      // This preliminary read verifies the original locator and committed corpus.
      // Its captureAuthority:false proof is never adopted as capture authority.
      const inventory=await readCase01MemoryCorpusInTx(factory.deps,tx,ctx,scope.clientId);
      assert.equal(inventory.fixtureReady,true);assert.deepEqual(inventory.missing,[]);
      assert.equal(inventory.captureAuthority,false);
      const rows=await tx.$queryRawUnsafe("SELECT settings_jsonb->'meriFoundationFixture'->'case01MemoryOwner' AS locator FROM tenants WHERE id=$1::uuid FOR UPDATE",ctx.tenantId);
      assert.equal(rows.length,1);
      const locator=rows[0].locator;
      assert.equal(locator.fixtureNamespace,input.fixtureNamespace);
      assert.equal(locator.proposerUserId,ctx.userId);
      assert.equal(locator.clients.ASTER.physicalId,scope.clientId);
      const config={clients:locator.clients,actors:locator.actors,uploaderActors:locator.uploaderActors};
      const previousManifest=await buildFixtureManifest({...config,fixtureInstanceId:locator.previousFixtureInstanceId});
      const currentManifest=await buildFixtureManifest({...config,fixtureInstanceId:locator.currentFixtureInstanceId});
      const runtimeDeps={...factory.deps,proposerForTenant:tenantId=>{
        assert.equal(tenantId,ctx.tenantId);return locator.proposerUserId;
      },reviewerForTenant:()=>{throw new Error('CANONICAL_BIND_PLAN_HAS_NO_REVIEW_AUTHORITY');}};
      const previous=createCase01MemoryFixtureRuntime({...runtimeDeps,manifest:previousManifest});
      await previous.hydrateInTx(tx,ctx,{lifecycle:'retired'});
      const current=createCase01MemoryFixtureRuntime({...runtimeDeps,manifest:currentManifest,previousOwner:previous});
      await current.hydrateInTx(tx,ctx,{lifecycle:'current'});
      // The existing canonical runtime qualifies on the binding owner's actual
      // transaction and holds source/version/permission locks. No receipt replay.
      actualProof=await current.qualifyInTx(tx,ctx,scope);
      for(const key of ['fixtureVersion','physicalMapSha256','seedReceiptId','resetReceiptId','currentVerifySha256'])
        assert.equal(actualProof[key],inventory[key]);
      assert.equal(sha256Stable(actualProof.currentVerify),inventory.currentVerifySha256);
      return actualProof;
    }};
    const owner=createCaptureBindingOwner({prisma:factory.deps.prisma,sourceAuthority});
    const request={tenantId:input.ctx.tenantId,tenantSlug:input.ctx.tenantSlug,actorUserId:input.ctx.userId,
      clerkUserId:input.ctx.clerkUserId,clientId:input.clientId,caseId:'01',captureRunId:input.prospectiveCaptureRunId};
    const plan=await owner.inspect(request);
    const saved=await factory.deps.prisma.withTenantUser(input.ctx.tenantId,input.ctx.userId,async tx=>{
      const rows=await tx.$queryRawUnsafe("SELECT settings_jsonb->'meriFoundationFixture' AS fixture,xmin::text AS row_version FROM tenants WHERE id=$1::uuid AND slug=$2",input.ctx.tenantId,input.ctx.tenantSlug);
      assert.equal(rows.length,1);
      const f=rows[0].fixture;
      return {tenantRowVersion:rows[0].row_version,fixtureNamespace:f.fixtureNamespace,
        captureBinding:f.captureEvidence??null,locatorSha256:hash(f.case01MemoryOwner??null),
        priorRateQualification:f.captureProviderBudget?{caseId:f.captureProviderBudget.caseId,captureRunId:f.captureProviderBudget.captureRunId,
          rateEvidenceExpiresAt:f.captureProviderBudget.rateEvidenceExpiresAt,currentVerifySha256:f.captureProviderBudget.currentVerifySha256,
          maxTokens:f.captureProviderBudget.maxTokens,maxCostMicros:f.captureProviderBudget.maxCostMicros}:null};
    });
    assert.equal(plan.expectedTenantRowVersion,saved.tenantRowVersion);
    return {status:'CANONICAL_BINDING_PLAN_ONLY',request,plan,actualProof,saved};
  });
  console.log('C2_CASE01_CURRENT_PLAN '+JSON.stringify({recordedAt:new Date().toISOString(),...result,
    captureAuthority:false,fixtureMutations:0,providerCalls:0,conversationCreations:0,liveAcceptance:'NOT_RUN'}));
} catch(error) {
  const code=/^(?:CASE01_[A-Z_]+|CAPTURE_BINDING_[A-Z_]+)$/.test(error?.code??'')?error.code:null;
  console.log('C2_CASE01_CURRENT_PLAN '+JSON.stringify({status:'READ_FAILED',code,captureAuthority:false,fixtureMutations:0,providerCalls:0,liveAcceptance:'NOT_RUN'}));
  process.exitCode=1;
} finally {if(factory)await factory.close();}
