import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { guardedEngagementServiceMethods } from '../engagement/governed-engagement.factory.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { ClientDocumentWriterService } from './client-document-writer.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;

function shadowPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

function activePolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'api',
    processMode: 'active',
    backgroundOwner: 'api',
    externalActions: 'enabled',
    callbacksEnabled: true,
    recallWebhookEnabled: true,
  });
}

const shadowCases: Array<{
  method: 'createAttachmentFromBuffer' | 'supersedeAttachment' | 'deleteAttachment';
  args: unknown[];
}> = [
  {
    method: 'createAttachmentFromBuffer',
    args: [
      ctx,
      {
        fileName: 'memo.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('memo'),
      },
    ],
  },
  { method: 'supersedeAttachment', args: [ctx, 'old-id', 'new-id'] },
  { method: 'deleteAttachment', args: [ctx, 'attachment-id'] },
];

describe('ClientDocumentWriterService runtime boundary', () => {
  it.each(shadowCases)('blocks $method before the authoritative implementation in shadow', ({ method, args }) => {
    const implementation = jest.fn(async () => ({ unsafe: true }));
    const engagement = { [method]: implementation };
    const service = new ClientDocumentWriterService(engagement as never, shadowPolicy());
    const call = service[method] as unknown as (...values: unknown[]) => unknown;

    expect(() => call(...args)).toThrow(ServiceUnavailableException);
    expect(implementation).not.toHaveBeenCalled();
  });

  it('delegates unchanged in the active main runtime', async () => {
    const createAttachmentFromBuffer = jest.fn(async () => ({
      id: 'attachment-id',
      fileName: 'memo.txt',
      s3Key: 'tenants/t/engagement/memo.txt',
    }));
    const service = new ClientDocumentWriterService(
      { createAttachmentFromBuffer } as never,
      activePolicy(),
    );

    await expect(
      service.createAttachmentFromBuffer(ctx, {
        fileName: 'memo.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('memo'),
      }),
    ).resolves.toMatchObject({ id: 'attachment-id' });
    expect(createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('keeps every direct externally sensitive document method in the Engagement proxy map', () => {
    expect(guardedEngagementServiceMethods()).toMatchObject({
      createAttachmentFromBuffer: { action: 'attachment_external_write' },
      supersedeAttachment: { action: 'attachment_external_write' },
      deleteAttachment: { action: 'attachment_external_write' },
      reconcileFailedAttachmentDeletes: { action: 'attachment_external_write' },
      extractAttachmentText: { action: 'attachment_external_read' },
      readAttachmentBytes: { action: 'attachment_external_read' },
    });
  });
});
