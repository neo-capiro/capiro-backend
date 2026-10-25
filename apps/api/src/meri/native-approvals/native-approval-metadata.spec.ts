import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal, type NativeApprovalProposal } from './native-approval.contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const binding = {tenantId:id(1),actorId:id(2),conversationId:id(3),runId:id(4),attemptId:id(5),workerId:id(6),writerFence:1};
function fixture(action='task.create') {
  const command: NativeApprovalProposal['command'] = {contractVersion:action==='task.create'?'0.1.0':'0.2.0',
    commandId:id(7),binding,action,arguments:action==='task.create'?{title:'Call the delegation',clientId:null,dueDate:null}
      :{taskId:id(170),mode:'unconditional_patch',patch:{status:'todo',dueDate:'2026-11-01T00:00:00.000Z'}},
    attachments:[],scopes:[{tenantId:id(1),kind:'private-user',resourceId:id(2),policyRevision:'policy1'}],idempotencyKey:'task-intent'};
  const proposal: NativeApprovalProposal = {proposalId:id(8),command,commandSha256:hash(command),
    createdAt:'2026-10-18T10:00:00.000Z',expiresAt:'2026-10-18T10:10:00.000Z',requiredApprover:{tenantId:id(1),actorId:id(2)}};
  const metadata: any = {record:{operation:{id:action==='task.create'?'create_task':'update_task',version:'0.2.0'},action,binding,
    request:action==='task.create'?{title:'  Call the delegation  '}:{taskId:` ${id(170).toUpperCase()} `,status:' OPEN ',title:' ',dueDate:' 2026-11-01 '},
    inputSha256:hash({arguments:command.arguments,attachments:[]}),commandId:command.commandId,idempotencyKey:command.idempotencyKey,
    proposalId:proposal.proposalId,scopes:command.scopes,createdAt:proposal.createdAt,expiresAt:proposal.expiresAt,requiredApprover:proposal.requiredApprover},
    commandContext:action==='task.create'?{binding,clientResolution:null}:{binding},commandSha256:proposal.commandSha256};
  const response: any = {schemaVersion:1,commandSha256:proposal.commandSha256,metadata,run:{binding,scopes:command.scopes,state:'completed'}};
  const verifier=new NativeApprovalMetadataVerifier({get:(name:string)=>name==='MERI_CONTROL_ORIGIN'
    ?'https://control.synthetic.invalid':name==='INTERNAL_SERVICE_SECRET'?'synthetic-secret':undefined} as never);
  const fetcher=jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    expect(String(url)).toBe('https://control.synthetic.invalid/v1/internal/approval-metadata/read');
    expect(JSON.parse(init?.body as string)).toEqual({schemaVersion:1,proposalId:proposal.proposalId,binding});
    return Response.json(response);
  });
  const rehash=()=>{proposal.commandSha256=hash(command);response.commandSha256=proposal.commandSha256;metadata.commandSha256=proposal.commandSha256;
    metadata.record.inputSha256=hash({arguments:command.arguments,attachments:[]});};
  return {proposal,command,metadata,response,verifier,fetcher,rehash};
}
afterEach(()=>{jest.restoreAllMocks();});

function initialFixture(action='task.create', general=true) {
  const f=fixture(action),selectedClientId=general?null:id(20);
  f.command.scopes=[{tenantId:binding.tenantId,kind:general?'private-user':'client',resourceId:selectedClientId??binding.actorId,policyRevision:'policy1'}];
  f.metadata.record.scopes=f.command.scopes;f.rehash();
  const record:any={schemaVersion:1,state:'ADMITTED',binding,selectedClientId,policyRevision:'policy1',
    versions:{imageDigest:`sha256:${'a'.repeat(64)}`,sdk:'0.3.295',cli:'2.1.295',contracts:'0.1.0',skillsDigest:'b'.repeat(64),checkpointFormat:'0.1.0'},
    configurationSha256:'c'.repeat(64),expiresAtMs:Date.now()+60000,createdAtMs:Date.parse(f.proposal.createdAt)-1000};
  const preparation:any={kind:'initial-binding',record,recordSha256:hash(record),generation:1,latestGeneration:1,started:false};
  delete f.response.run;f.response.preparation=preparation;
  const rehashRecord=()=>{preparation.recordSha256=hash(record);};
  return {...f,record,preparation,rehashRecord};
}

describe.each(['task.create','task.update'])('%s retained initial-binding preparation',action=>{
  it.each([false,true])('accepts exact admitted custody without a run, General=%s',async general=>{
    const f=initialFixture(action,general);
    await expect(f.verifier.verify(parseApprovalProposal(f.proposal))).resolves.toBeUndefined();
  });
  it.each(['expired','expiry-boundary','superseded','started','superseded-started'])('accepts %s immutable preparation provenance',async kind=>{
    const f=initialFixture(action);
    if(kind==='expired')f.record.expiresAtMs=Date.now()-1;
    if(kind==='expiry-boundary'){const at=Date.now();f.record.expiresAtMs=at;jest.spyOn(Date,'now').mockReturnValue(at);}
    if(kind.startsWith('superseded'))f.preparation.latestGeneration=2;
    if(kind.includes('started'))f.preparation.started=true;
    f.rehashRecord();
    await expect(f.verifier.verify(f.proposal)).resolves.toBeUndefined();
  });
  it.each(['tenantId','actorId','conversationId','runId','attemptId','workerId','writerFence'])('rejects original binding substitution: %s',async field=>{
    const f=initialFixture(action);f.record.binding={...binding,[field]:field==='writerFence'?2:id(99)};f.rehashRecord();
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each([
    ['schemaVersion',2],['state','PREPARED'],['selectedClientId',id(99)],['selectedClientId','not-a-uuid'],
    ['policyRevision','another-policy'],['policyRevision',''],['configurationSha256','A'.repeat(64)],
    ['createdAtMs',-1],['createdAtMs',1.5],['createdAtMs',Number.MAX_SAFE_INTEGER+1],
    ['createdAtMs',Date.parse('2026-10-18T10:00:00.001Z')],['expiresAtMs',0],['expiresAtMs',1.5],
  ])('rejects rehashed invalid record %s=%s',async(field,value)=>{
    const f=initialFixture(action);f.record[field as string]=value;f.rehashRecord();
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each([
    ['imageDigest','sha256:bad'],['sdk','next'],['cli','2.1'],['contracts','0.2.0'],['skillsDigest','B'.repeat(64)],['checkpointFormat','0.2.0'],
  ])('rejects invalid runtime version %s',async(field,value)=>{
    const f=initialFixture(action);f.record.versions[field]=value;f.rehashRecord();
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each([
    ['kind','run'],['generation',0],['generation',1.5],['generation',2],['latestGeneration',0],
    ['latestGeneration',Number.MAX_SAFE_INTEGER+1],['started','false'],['recordSha256','0'.repeat(64)],
  ])('rejects invalid preparation %s=%s',async(field,value)=>{
    const f=initialFixture(action);f.preparation[field as string]=value;
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['top','preparation','record','versions'])('rejects additional fields at %s',async layer=>{
    const f=initialFixture(action),target=layer==='top'?f.response:layer==='preparation'?f.preparation:layer==='record'?f.record:f.record.versions;
    target.extra=true;f.rehashRecord();await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['both','neither','missing-record-field','missing-version'])('requires the exclusive exact variant (%s)',async kind=>{
    const f=initialFixture(action);
    if(kind==='both')f.response.run={binding,scopes:f.command.scopes,state:'completed'};
    if(kind==='neither')delete f.response.preparation;
    if(kind==='missing-record-field')delete f.record.configurationSha256;
    if(kind==='missing-version')delete f.record.versions.sdk;
    f.rehashRecord();await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it('requires the single canonical scope derived from the original selector',async()=>{
    const f=initialFixture(action);f.command.scopes.push({...f.command.scopes[0]!,kind:'document',resourceId:id(80)});f.rehash();
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it('still normalizes and binds the actual task request in the initial variant',async()=>{
    const f=initialFixture(action);f.metadata.record.request.title='Substituted';
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe.each(['task.create','task.update'])('%s immutable native metadata',action=>{
  it('normalizes the raw request and context exactly, including a completed run after proposal expiry',async()=>{
    const f=fixture(action);expect(f.metadata.record.request).not.toEqual(f.command.arguments);
    await expect(f.verifier.verify(parseApprovalProposal(f.proposal))).resolves.toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains immutable command evidence after the preparation run fails following an effect',async()=>{
    const f=fixture(action);f.response.run.state='failed';
    await expect(f.verifier.verify(parseApprovalProposal(f.proposal))).resolves.toBeUndefined();
    f.metadata.record.request.title='Substituted after failure';
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['tenantId','actorId','conversationId','runId','attemptId','workerId','writerFence'])('rejects substituted run %s',async field=>{
    const f=fixture(action);f.response.run.binding={...binding,[field]:field==='writerFence'?2:id(99)};
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['proposalId','commandId','idempotencyKey','createdAt','expiresAt','requiredApprover','scopes','operation','inputSha256'])('rejects changed retained %s',async field=>{
    const f=fixture(action);f.metadata.record[field]=field==='scopes'?[]:field==='requiredApprover'?{tenantId:id(1),actorId:id(99)}
      :field==='operation'?{id:'create_task',version:'0.1.0'}:'changed';
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['context','request','metadata','record'])('rejects additional %s fields',async field=>{
    const f=fixture(action);const target=field==='context'?f.metadata.commandContext:field==='request'?f.metadata.record.request
      :field==='metadata'?f.metadata:f.metadata.record;target.extra=true;
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects a changed raw effect even when the supplied command hash is unchanged',async()=>{
    const f=fixture(action);f.metadata.record.request.title='Substituted';
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects private metadata I/O while a caller holds its database transaction',async()=>{
    const f=fixture(action);await expect(f.verifier.verify(f.proposal,{} as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('task create client resolution and dates',()=>{
  it.each([undefined,null,'','  '])('keeps omitted/empty client reference personal (%s)',async reference=>{
    const f=fixture();if(reference!==undefined)f.metadata.record.request.clientId=reference;
    await expect(f.verifier.verify(f.proposal)).resolves.toBeUndefined();
    f.metadata.commandContext.clientResolution={reference:'Selected client',clientId:id(20)};
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['Selected client',id(170).toUpperCase()])('requires the exact explicit resolution for %s',async reference=>{
    const f=fixture();f.metadata.record.request.clientId=` ${reference} `;
    f.metadata.record.request.dueDate=' 2026-11-01 ';
    f.metadata.commandContext.clientResolution={reference,clientId:id(170).toUpperCase()};
    f.command.arguments.clientId=id(170);f.command.arguments.dueDate='2026-11-01T00:00:00.000Z';f.rehash();
    await expect(f.verifier.verify(f.proposal)).resolves.toBeUndefined();
    f.metadata.commandContext.clientResolution.clientId=id(99);
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['2026-02-30','2026-11-01T12:00:00.000Z','2026-11-01T00:00:00Z'])('refuses noncanonical or invalid date %s',async dueDate=>{
    const f=fixture();f.metadata.record.request.dueDate=dueDate;
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('task update exact command contract',()=>{
  it('accepts only the canonical update version and normalized nonempty patch',()=>{
    const f=fixture('task.update');expect(parseApprovalProposal(f.proposal)).toEqual(f.proposal);
    const invalid=[{contractVersion:'0.1.0'},{attachments:[{}]},{arguments:{...f.command.arguments,revision:1}},
      {arguments:{...f.command.arguments,taskId:id(170).toUpperCase()}},
      {arguments:{...f.command.arguments,mode:'compare_and_swap'}},
      ...[{}, {title:' padded '},{title:''},{status:'open'},{status:'cancelled'},{dueDate:null},{dueDate:'2026-11-01'},
        {dueDate:'2026-11-01T12:00:00.000Z'},{clientId:id(20)}].map(patch=>({arguments:{...f.command.arguments,patch}}))];
    for(const delta of invalid){const command={...f.command,...delta};
      expect(()=>parseApprovalProposal({...f.proposal,command,commandSha256:hash(command)})).toThrow(BadRequestException);}
  });
  it.each([null,'','  '])('omits empty fields without clearing their current values (%s)',async empty=>{
    const f=fixture('task.update');f.metadata.record.request={taskId:id(170),title:empty,status:'DONE',dueDate:empty};
    f.command.arguments.patch={status:'done'};f.rehash();
    await expect(f.verifier.verify(f.proposal)).resolves.toBeUndefined();
    f.metadata.record.request.status=empty;
    await expect(f.verifier.verify(f.proposal)).rejects.toBeInstanceOf(ConflictException);
  });
});
