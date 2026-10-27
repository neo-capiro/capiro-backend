// Exercise the actual service boundary. Unrelated document/AI/provider constructors
// are mocked; current admission and the send orchestration remain production code.
jest.doMock('@nestjs/throttler', () => ({ Throttle: () => () => {} }), { virtual: true });
for (const module of [
  '../ai-credentials/ai-credential-resolver.service.js',
  './attachment-pdf-vision.js',
  './generation/generation-gateway.service.js',
  './generation/outreach-truth.service.js',
  './generation/evidence-source.service.js',
  './attachment-content.service.js',
  './attachment-scanner.service.js',
  './outreach-draft.service.js',
  '../quality-telemetry/quality-telemetry-capture.service.js',
  '../directory/directory.service.js',
  '../lobby-intel/lobby-intel.service.js',
  '../federal-spending/federal-spending.service.js',
  './client-association.service.js',
  './engagement-ai.service.js',
  './meeting-notes-crypto.service.js',
  '../embeddings/client-kb.service.js',
  './generation/alert-packet-client.service.js',
  '../prisma/prisma.service.js',
  './xlsx-extract.js',
  './pptx-extract.js',
  './meeting-prep-pdf.js',
  './attachment-context-extract.js',
  './meeting-prep-job.service.js',
  './outreach-job.service.js',
  './notetaker/notetaker.service.js',
  './outreach-send-intent.service.js',
])
  jest.doMock(module, () => new Proxy({}, { get: () => class {} }));
for (const module of [
  '@aws-sdk/s3-presigned-post',
  '@aws-sdk/s3-request-presigner',
  '@capiro/meriv2-core',
  'mammoth',
]) {
  jest.doMock(module, () => new Proxy({}, { get: () => class {} }), { virtual: true });
}
jest.doMock('./mail-sender.service.js', () => ({
  EngagementMailSender: class {},
  sendProviderSlug: () => 'gmail',
}));
jest.doMock('../common/sanitize-signature.js', () => ({
  sanitizeSignatureHtml: (value: string) => value,
}));


jest.doMock('@aws-sdk/client-s3', () => ({ PutObjectCommand: class { constructor(public input: unknown) {} }, HeadObjectCommand: class { constructor(public input: unknown) {} } }));
jest.doMock('./google/gmail-send.service.js', () => ({ GmailSendService: class {} }));
jest.doMock('./microsoft/microsoft-graph-sync.service.js', () => ({ MicrosoftGraphSyncService: class {} }));

const { EngagementService } = require('./engagement.service.js') as typeof import('./engagement.service.js');
const { MailIncomingFilesService, incomingMailSelection } = require('./mail-incoming-files.service.js') as typeof import('./mail-incoming-files.service.js');
const { readIncomingProviderFiles } = require('./mail-incoming-files.js') as typeof import('./mail-incoming-files.js');
const { createHash } = require('node:crypto') as typeof import('node:crypto');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ctx={tenantId:uuid(1),userId:uuid(2),role:'standard_user'} as never;
const selected={threadId:uuid(3),messageId:uuid(4),updatedAt:'2026-10-27T00:00:00.000Z'};
const hash=(b: Buffer)=>createHash('sha256').update(b).digest('hex');

function fixture() {
  let active=true,member=true,status='connected',scan='pending';
  const rows=new Map<string,any>();
  const providerMessage={id:'gmailMessage',threadId:'gmailThread',historyId:'1',payload:{partId:'',filename:'memo.txt',mimeType:'text/plain',
    headers:[{name:'Content-Disposition',value:'attachment'}],body:{size:4,attachmentId:'file'}}};
  const tx:any={
    $executeRaw:jest.fn().mockResolvedValue(1),
    tenantMembership:{findFirst:jest.fn(async()=>member?{id:uuid(5)}:null)},
    mailThread:{findFirst:jest.fn(async()=>active?{id:selected.threadId,clientId:null,connectionId:uuid(6),source:'google',externalId:'gmailThread'}:null)},
    mailMessage:{findFirst:jest.fn(async()=>active?{id:selected.messageId,updatedAt:new Date(selected.updatedAt),externalId:'gmailMessage',source:'google',raw:providerMessage,thread:{clientId:null}}:null)},
    integrationConnection:{findFirst:jest.fn(async(args:any)=>args.where.createdByUserId===uuid(2)&&status==='connected'?{id:uuid(6),provider:'google_workspace',accountEmail:'actor@example.test'}:null)},
    engagementAttachment:{findFirst:jest.fn(async(args:any)=>rows.get(args.where.id)??null),findMany:jest.fn(async()=>[...rows.values()]),upsert:jest.fn(async(args:any)=>{if(!rows.has(args.where.id))rows.set(args.where.id,args.create);return rows.get(args.where.id);})},
    user:{findMany:jest.fn().mockResolvedValue([])},
    client:{findFirst:jest.fn().mockResolvedValue({id:uuid(7)})},
    $queryRawUnsafe:jest.fn().mockResolvedValue([{allowed:false}]),
  };
  const prisma={withTenant:async(_tenant:string,run:any)=>run(tx)};
  const writer=Object.create(EngagementService.prototype) as any;
  writer.prisma=prisma;writer.bucket='synthetic-bucket';writer.s3={send:jest.fn().mockResolvedValue({})};
  writer.attachmentContent={detectContentType:()=>null,contentTypeConflicts:()=>false,sha256:hash,
    readiness:(row:any)=>({usable:row.lifecycleStatus==='ready'})};
  writer.createAttachmentDownloadUrl=jest.fn().mockResolvedValue('synthetic-download');
  writer.createAttachmentPreviewUrl=jest.fn().mockResolvedValue('synthetic-preview');
  writer.scanner={getStatus:jest.fn(async()=>scan),scanRequired:true,providerName:'synthetic'};
  writer.clientKb={indexAttachmentFireAndForget:jest.fn()};
  const get=jest.fn(async(url:string)=>url.includes('/attachments/')?{data:'bWVtbw',size:4}:providerMessage);
  const adapter={readIncomingFiles:jest.fn(async(_ctx:any,_id:any,source:any,selection:any,allow:any)=>readIncomingProviderFiles(source,get,selection,allow))};
  const runtime={assertExternalAction:jest.fn()};
  const service=new MailIncomingFilesService(prisma as never,writer,adapter as never,adapter as never,runtime as never);
  return {service,writer,tx,rows,adapter,get,runtime,setActive:(v:boolean)=>active=v,setMember:(v:boolean)=>member=v,setStatus:(v:string)=>status=v,setScan:(v:string)=>scan=v};
}
async function selection(f:ReturnType<typeof fixture>) {
  const page=await f.service.read(ctx,selected);
  if(page.state!=='manifest')throw Error('manifest expected');
  return {fileKey:page.files[0]!.fileKey,manifestSha256:page.manifestSha256};
}

describe('incoming file current owner and existing durable attachment writer',()=>{
  it('publishes a metadata-only selected manifest without raw provider selectors',async()=>{
    const f=fixture(),page=await f.service.read(ctx,selected);
    expect(page.state).toBe('manifest');
    expect(JSON.stringify(page)).not.toContain('gmailMessage');
    expect(JSON.stringify(page)).not.toContain('attachmentId');
    expect(f.writer.s3.send).not.toHaveBeenCalled();
    expect(f.tx.integrationConnection.findFirst.mock.calls[0][0].where).toMatchObject({tenantId:uuid(1),createdByUserId:uuid(2),status:'connected'});
    expect(f.tx.mailMessage.findFirst.mock.calls[0][0].where).toMatchObject({tenantId:uuid(1),threadId:selected.threadId,connectionId:uuid(6),removedAt:null});
  });
  it('imports through actual writer as private quarantined bytes with a durable original/digest, without URL or indexing',async()=>{
    const f=fixture(),pick=await selection(f),result=await f.service.read(ctx,selected,pick);
    expect(result).toMatchObject({state:'imported',attachment:{lifecycleStatus:'quarantined',scanStatus:'pending',sha256:hash(Buffer.from('memo'))},reused:false});
    const row=[...f.rows.values()][0];
    expect(row).toMatchObject({mailMessageId:selected.messageId,viewerMode:'restricted',viewerUserIds:[uuid(2)],source:'incoming_mail',sourceEntityType:'incoming_mail_file',sourceVersion:1});
    expect(row.sourceEntityId).toMatch(new RegExp(`^${selected.messageId}:[a-f0-9]{64}$`));
    expect(f.writer.s3.send.mock.calls[0][0].input).toMatchObject({IfNoneMatch:'*',ChecksumSHA256:Buffer.from(hash(Buffer.from('memo')),'hex').toString('base64')});
    expect(JSON.stringify(result)).not.toMatch(/s3Key|downloadUrl|previewUrl/);
    expect(f.writer.clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
  });
  it('reuses the durable row on duplicate import without storing/scanning again',async()=>{
    const f=fixture(),pick=await selection(f);f.setScan('clean');
    const first=await f.service.read(ctx,selected,pick),again=await f.service.read(ctx,selected,pick);
    expect(first.state).toBe('imported');expect(again).toMatchObject({state:'imported',reused:true,attachment:{lifecycleStatus:'ready'}});
    expect(f.rows.size).toBe(1);expect(f.writer.s3.send).toHaveBeenCalledTimes(1);expect(f.writer.scanner.getStatus).toHaveBeenCalledTimes(1);
  });
  it.each(['member','mailbox','original'] as const)('refuses current %s revocation before provider read',async(kind)=>{
    const f=fixture();if(kind==='member')f.setMember(false);if(kind==='mailbox')f.setStatus('disconnected');if(kind==='original')f.setActive(false);
    await expect(f.service.read(ctx,selected)).rejects.toThrow('not found');
    expect(f.adapter.readIncomingFiles).not.toHaveBeenCalled();
  });
  it('refuses source deletion after provider return before storage',async()=>{
    const f=fixture(),pick=await selection(f),read=f.adapter.readIncomingFiles.getMockImplementation()!;
    f.adapter.readIncomingFiles.mockImplementation(async(...args:any[])=>{const result=await (read as any)(...args);f.setActive(false);return result;});
    await expect(f.service.read(ctx,selected,pick)).rejects.toThrow('not found');expect(f.writer.s3.send).not.toHaveBeenCalled();
  });
  it('refuses removal during storage before DB receipt; no fabricated successful import',async()=>{
    const f=fixture(),pick=await selection(f);
    f.writer.s3.send.mockImplementation(async()=>{f.setActive(false);return {};});
    await expect(f.service.read(ctx,selected,pick)).rejects.toThrow('not found');expect(f.rows.size).toBe(0);
  });
  it('keeps malicious scan blocked, and does not label it usable',async()=>{
    const f=fixture(),pick=await selection(f);f.setScan('infected');
    expect(await f.service.read(ctx,selected,pick)).toMatchObject({state:'imported',attachment:{lifecycleStatus:'blocked',scanStatus:'infected'}});
    expect(f.writer.clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
  });
  it('existing attachment list releases URLs only after scan readiness and current mail membership',async()=>{
    const f=fixture(),pick=await selection(f);await f.service.read(ctx,selected,pick);
    const pending=await f.writer.listAttachments(ctx,{mailMessageId:selected.messageId});
    expect(pending[0]).toMatchObject({usable:false,downloadUrl:null,previewUrl:null});
    const row=[...f.rows.values()][0];row.lifecycleStatus='ready';row.scanStatus='clean';
    expect((await f.writer.listAttachments(ctx,{mailMessageId:selected.messageId}))[0].downloadUrl).toBe('synthetic-download');
    f.writer.createAttachmentDownloadUrl.mockClear();f.setMember(false);
    await expect(f.writer.listAttachments(ctx,{mailMessageId:selected.messageId})).rejects.toThrow('not found');
    expect(f.writer.createAttachmentDownloadUrl).not.toHaveBeenCalled();
  });
  it('current parent wall denies import and existing incoming-file URL release through canonical predicate',async()=>{
    const f=fixture(),pick=await selection(f);await f.service.read(ctx,selected,pick);
    f.tx.mailThread.findFirst.mockResolvedValue({id:selected.threadId,clientId:uuid(7),connectionId:uuid(6),source:'google',externalId:'gmailThread'});
    await expect(f.service.read(ctx,selected)).rejects.toThrow('not found');
    const old=f.tx.mailMessage.findFirst.getMockImplementation()!;
    f.tx.mailMessage.findFirst.mockImplementation(async()=>({...await old(),thread:{clientId:uuid(7)}}));
    await expect(f.writer.listAttachments(ctx,{mailMessageId:selected.messageId})).rejects.toThrow('not found');
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalled();expect(f.writer.createAttachmentDownloadUrl).not.toHaveBeenCalled();
  });
  it('does not reuse a retained file after its private ACL or provenance changed',async()=>{
    const f=fixture(),pick=await selection(f);await f.service.read(ctx,selected,pick);
    [...f.rows.values()][0].viewerUserIds.push(uuid(8));
    await expect(f.service.read(ctx,selected,pick)).rejects.toThrow('cannot be reused');
    expect(f.writer.s3.send).toHaveBeenCalledTimes(1);
  });
  it('rejects spoofed provider selectors and noncanonical original revision at the input boundary',()=>{
    expect(()=>incomingMailSelection({...selected,providerId:'guessed'})).toThrow();
    expect(()=>incomingMailSelection({...selected,updatedAt:'2026-10-27'})).toThrow();
  });
});
