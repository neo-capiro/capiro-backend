import { EngagementService } from '../engagement.service.js';
import { OutreachSendIntentService } from '../outreach-send-intent.service.js';
import { OutreachV3SendService } from '../../outreach-v3/send/outreach-v3-send.service.js';
import { EvidenceSourceService } from '../generation/evidence-source.service.js';
import { OutreachContextReferenceService } from '../../capabilities/context/outreach-context-reference.service.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const prospect = '33333333-3333-4333-8333-333333333333';
const attachmentId = '44444444-4444-4444-8444-444444444444';
const client = '55555555-5555-4555-8555-555555555555';
const ctx: any = { tenantId: tenant, userId: actor, role: 'standard_user' };
const key = `tenants/${tenant}/engagement/prospect-uploads/intent/synthetic.txt`;
function fixture() {
  const state = { member: true, exists: true, linked: false, wall: false, grant: false, mode: 'ready', superseded: false };
  const intent = { id: 'intent', tenantId: tenant, actorUserId: actor, prospectId: prospect,
    fileName: 'synthetic.txt', contentType: 'text/plain', checksumSha256: 'a'.repeat(64),
    contentLength: 9, bucket: 'synthetic-only', s3Key: key, expiresAt: new Date(0), confirmedAttachmentId: attachmentId };
  const row = { id: attachmentId, tenantId: tenant, prospectId: prospect, clientId: null,
    meetingId: null, mailMessageId: null, uploadedByUserId: actor, s3Key: key, bucket: intent.bucket,
    lifecycleStatus: 'ready', supersededByAttachmentId: null, viewerMode: 'all', viewerUserIds: [] };
  const accepts = (where: any) => state.exists && Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'OR') return true;
    const actual = k === 'lifecycleStatus' ? state.mode : k === 'supersededByAttachmentId' && state.superseded ? 'replacement' : (row as any)[k];
    if (v && typeof v === 'object') return v.in ? v.in.includes(actual) : v.notIn ? !v.notIn.includes(actual) : false;
    return actual === v;
  });
  const tx: any = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: any[]) => {
      if (sql.includes('FROM business_development_prospects')) return values[0] === tenant && values[1] === prospect ? [{ status: 'active', dismissedAt: null, linkedClientId: state.linked ? client : null }] : [];
      if (sql.includes('FROM tenants')) return [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } } }];
      if (sql.includes('FROM tenant_memberships')) return state.member && values[1] === actor ? [{ userId: actor, clerkUserId: 'user_actor' }] : [];
      if (sql.includes('set_config')) return [];
      if (sql.includes('SELECT status,memory_wall')) return [{ status: 'active', memoryWall: state.wall }];
      if (sql.includes('SELECT id FROM client_memory_access')) return state.grant ? [{ id: 'grant' }] : [];
      if (sql.includes('AS allowed')) return [{ allowed: !state.wall || state.grant }];
      throw Error(sql);
    }),
    $executeRaw: jest.fn(async () => 1),
    prospectAttachmentUploadIntent: { findFirst: jest.fn(async () => intent) },
    engagementAttachment: {
      findFirst: jest.fn(async ({ where }: any) => accepts(where) ? row : null),
      findMany: jest.fn(async ({ where }: any) => accepts(where) ? [row] : []),
      create: jest.fn(async () => { throw Error('Unexpected attachment creation'); }),
    },
  };
  const prisma: any = {
    withTenant: jest.fn(async (t: string, fn: any) => { expect(t).toBe(tenant); return fn(tx); }),
    withTenantUser: jest.fn(async (t: string, u: string, fn: any) => { expect(t).toBe(tenant); expect(u).toBe(actor); return fn(tx); }),
    withSystem: jest.fn(async (fn: any) => fn(tx)),
  };
  const input = { prospectId: prospect, s3Key: key, fileName: intent.fileName, contentType: intent.contentType, checksumSha256: intent.checksumSha256 };
  const external = jest.fn(async () => { throw Error('External I/O forbidden in independent test'); });
  const service: any = Object.assign(Object.create(EngagementService.prototype), {
    prisma, bucket: intent.bucket, s3: { send: external }, readAttachmentBytes: external,
  });
  return { state, intent, row, tx, prisma, input, external, service,
    confirm: (patch = {}) => service.confirmAttachment(ctx, { ...input, ...patch }),
  };
}

describe('independent prospect attachment intent and alternate-consumer controls', () => {
  it('recovers confirmed exact replay after expiry without S3 access or recreation', async () => {
    const h = fixture();
    await expect(h.confirm()).resolves.toEqual(h.row);
    expect(h.external).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.create).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'delete_pending', 'delete_failed', 'superseded'])('keeps %s confirmed uploads consumed, without external calls', async (transition) => {
    const h = fixture();
    if (transition === 'deleted') h.state.exists = false;
    else if (transition === 'superseded') h.state.superseded = true;
    else h.state.mode = transition;
    await expect(h.confirm()).rejects.toMatchObject({ status: 409, response: { code: 'prospect_upload_consumed' } });
    expect(h.external).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.create).not.toHaveBeenCalled();
  });
  it.each(['fileName', 'contentType', 'checksumSha256', 'source'])('refuses changed %s before external reads even on confirmed replay', async (field) => {
    const h = fixture();
    await expect(h.confirm({ [field]: field === 'contentType' ? 'application/pdf' : 'changed' })).rejects.toMatchObject({ status: 409 });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('prevents legacy confirmation from laundering a reserved prospect upload key', async () => {
    const h = fixture();
    await expect(h.confirm({ prospectId: undefined })).rejects.toMatchObject({ status: 404 });
    expect(h.tx.prospectAttachmentUploadIntent.findFirst).not.toHaveBeenCalled();
    expect(h.external).not.toHaveBeenCalled();
  });
  it('refuses added legacy parents before any external reads', async () => {
    const h = fixture();
    await expect(h.confirm({ clientId: client })).rejects.toMatchObject({ status: 400 });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('rechecks revoked membership before returning the original uploader receipt', async () => {
    const h = fixture(); h.state.member = false;
    await expect(h.confirm()).rejects.toMatchObject({ status: 404 });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('retains origin after conversion and applies current client wall to receipt replay', async () => {
    const h = fixture(); h.state.linked = true; h.state.wall = true;
    await expect(h.confirm()).rejects.toMatchObject({ status: 404 });
    h.state.grant = true;
    await expect(h.confirm()).resolves.toMatchObject({ prospectId: prospect, clientId: null });
    h.state.grant = false;
    await expect(h.confirm()).rejects.toMatchObject({ status: 404 });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('refuses a foreign actor intent even when their tenant membership is otherwise valid', async () => {
    const h = fixture(); h.intent.actorUserId = 'foreign-actor';
    await expect(h.confirm()).rejects.toMatchObject({ status: 404 });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('rejects an unconfirmed expired intent instead of recreating or reading bytes', async () => {
    const h = fixture(); h.intent.confirmedAttachmentId = null as never;
    await expect(h.confirm()).rejects.toMatchObject({ status: 409, response: { code: 'prospect_upload_expired' } });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('excludes prospective bytes from both Outreach intent preparation and manifest recovery', async () => {
    const h = fixture();
    const service: any = Object.assign(Object.create(OutreachSendIntentService.prototype), {
      prisma: h.prisma, engagement: { readAttachmentBytes: h.external },
    });
    await expect(service.resolveAttachments(ctx, [attachmentId])).rejects.toMatchObject({ status: 400 });
    await expect(service.loadManifestBytes(ctx, [{ id: attachmentId }])).rejects.toThrow('no longer exists');
    expect(h.external).not.toHaveBeenCalled();
  });
  it('blocks generic Outlook/Graph selected attachment loading before bytes', async () => {
    const h = fixture();
    await expect(h.service.loadGraphAttachments(ctx, [attachmentId])).rejects.toMatchObject({ status: 400 });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('makes Outreach V3 selection unavailable instead of silently omitting the attachment', async () => {
    const h = fixture();
    const service: any = Object.assign(Object.create(OutreachV3SendService.prototype), { prisma: h.prisma });
    await expect(service.attachmentReadiness(ctx, [attachmentId])).resolves.toEqual({ ready: false, blockers: ['ATTACHMENT_NOT_FOUND'] });
    expect(h.external).not.toHaveBeenCalled();
  });
  it('refuses evidence and generic Outreach context document readers', async () => {
    const h = fixture();
    const evidence: any = Object.assign(Object.create(EvidenceSourceService.prototype), { prisma: h.prisma });
    const result = await evidence.resolveDocument(ctx, { id: `doc-${attachmentId}`, type: 'document' }, {});
    expect(result.failures).toHaveLength(1);
    const context: any = Object.create(OutreachContextReferenceService.prototype);
    await expect(context.resolveDocument(h.tx, ctx, { source: 'document', id: attachmentId, clientId: client })).rejects.toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
    expect(h.external).not.toHaveBeenCalled();
  });
});
