import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import {
  hashOutreachTemplateSpecV1,
  templateSpecFromCampaign,
} from './outreach-template.contract.js';
import { computeTemplateApplicationFingerprint } from './outreach-template-authorization.js';
import { OutreachTemplateService } from './outreach-template.service.js';
import type {
  OutreachTemplateRow,
  OutreachTemplateVersionRow,
} from './outreach-template.repository.js';

export function recoveryFixture() {
  const ctx = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    role: 'user_admin',
    tenantSlug: 'test',
    clerkUserId: 'test',
  } as TenantContext;
  const spec = templateSpecFromCampaign(createBlankCampaignSpecV1());
  const version: OutreachTemplateVersionRow = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    templateId: randomUUID(),
    versionNumber: 1,
    lifecycle: 'draft',
    templateSpecJsonb: spec,
    contentHash: hashOutreachTemplateSpecV1(spec),
    sourceSessionId: null,
    sourceStateVersion: null,
    createdByUserId: ctx.userId,
    createdAt: new Date('2026-10-01'),
    publishedAt: null,
  };
  const template: OutreachTemplateRow = {
    id: version.templateId,
    tenantId: ctx.tenantId,
    ownerUserId: ctx.userId,
    clientId: null,
    scope: 'private',
    name: 'Synthetic template',
    description: null,
    campaignType: null,
    status: 'active',
    currentDraftVersionId: version.id,
    publishedVersionId: version.id,
    duplicatedFromTemplateId: null,
    duplicatedFromVersionId: null,
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
    archivedAt: null,
  };
  const tx = {};
  const templates = {
    lockManaged: jest.fn(async () => template),
    getVisible: jest.fn(async () => template),
    getVersion: jest.fn(async () => version),
    publishDraft: jest.fn(async () => ({
      ...version,
      lifecycle: 'published',
      publishedAt: new Date(),
    })),
    lockApplicationRequest: jest.fn(async (): Promise<void> => undefined),
    findApplicationByRequestKey: jest.fn(),
    recordAudit: jest.fn(async () => undefined),
    recordApplication: jest.fn(),
    getProvenanceForSession: jest.fn(),
  };
  const sessions = { loadCurrentSpecWithinTx: jest.fn(async () => createBlankCampaignSpecV1()) };
  const state = { createSessionWithinTx: jest.fn(async () => ({ id: randomUUID() })) };
  const commands = {
    parseNormalizeAndValidateBatch: jest.fn((value) => value),
    applyBatchWithinTx: jest.fn(async () => ({ stateVersion: 2 })),
  };
  const authorization = {
    authorizeClientWithinTx: jest.fn(async () => undefined),
    authorizeClient: jest.fn(async () => undefined),
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant, _actor, fn) => fn(tx)) };
  const service = new OutreachTemplateService(
    prisma as never,
    templates as never,
    sessions as never,
    state as never,
    commands as never,
    authorization as never,
    {} as never,
  );
  const input = {
    requestKey: randomUUID(),
    title: 'Frozen title',
    variableValues: { answer: 'Frozen answer' },
  };
  const application = {
    id: randomUUID(),
    templateId: template.id,
    templateVersionId: version.id,
    sessionId: randomUUID(),
    requestKey: input.requestKey,
    resultingStateVersion: 2,
    receiptJsonb: { inherited: ['original'] },
    requestFingerprint: computeTemplateApplicationFingerprint({
      actorUserId: ctx.userId,
      templateId: template.id,
      templateVersionId: version.id,
      clientId: null,
      ...input,
    }),
  };
  return {
    ctx,
    tx,
    spec,
    version,
    template,
    templates,
    sessions,
    state,
    commands,
    authorization,
    prisma,
    service,
    input,
    application,
  };
}
