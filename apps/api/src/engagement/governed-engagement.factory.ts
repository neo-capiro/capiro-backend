import type { TenantContext } from '@capiro/shared';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { rethrowRequiredContextPersistence } from '../context/context-required-persistence.js';
import { EngagementService } from './engagement.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import type { EngagementExternalAction } from './runtime/engagement-runtime.types.js';

export const RAW_ENGAGEMENT_SERVICE = Symbol('RAW_ENGAGEMENT_SERVICE');

type GenerateDraft = EngagementService['generateOutreachDraft'];
type GenerateBatch = EngagementService['generateBatchEmails'];

interface GovernedEngagementMethods {
  loadUserVoiceBlock: (ctx: TenantContext, clientId: string | null) => Promise<string | null>;
  generateOutreachDraft: GenerateDraft;
  generateBatchEmails: GenerateBatch;
}

const RUNTIME_ACTION_BY_METHOD = {
  previewAiTemplate: { action: 'outreach_generate' },
  generateTalkingPoints: { action: 'outreach_generate' },
  generateBatchEmails: { action: 'outreach_generate' },
  generateOutreachDraft: { action: 'outreach_generate' },
  generateCampaignEmail: { action: 'outreach_generate' },
  generateMeetingPrep: { action: 'meeting_prep_generate' },
  generateMeetingDebriefDraft: { action: 'meeting_debrief_generate' },
  sendBatchEmails: { action: 'outreach_send' },
  openOutreachEmail: { action: 'outreach_send' },
  sendCampaign: { action: 'outreach_send' },
  sendCampaignEmails: { action: 'outreach_send' },
  sendCampaignTest: { action: 'outreach_test_send', testMode: true },
  createAttachmentUploadUrl: { action: 'attachment_external_write' },
  confirmAttachment: { action: 'attachment_external_write' },
  extractAttachmentText: { action: 'attachment_external_read' },
  deleteAttachment: { action: 'attachment_external_write' },
} as const satisfies Readonly<
  Record<string, { action: EngagementExternalAction; testMode?: boolean }>
>;

/**
 * Preserve the existing EngagementService implementation while hardening the
 * exact context-loader and externally sensitive public entry points.
 *
 * The controller guard remains the first boundary. This proxy is the independent
 * service boundary for workers, internal callers, or future controller refactors:
 * it asserts runtime policy before enrichment, database writes, S3 access,
 * transcription, model calls, or provider sends can begin.
 */
export function createGovernedEngagementService(
  service: EngagementService,
  boundary: ContextPersistenceBoundaryService,
  contextCompiler: ContextCompilerService,
  runtimePolicy: EngagementRuntimePolicyService,
): EngagementService {
  const methods = service as unknown as GovernedEngagementMethods;

  methods.loadUserVoiceBlock = async (ctx, clientId) => {
    try {
      const packet = await contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'outreach',
        layers: ['user-voice', 'firm-identity', 'client-steering', 'client-people'],
      });

      const parts: string[] = [];
      for (const item of packet.rendered) {
        switch (item.layer) {
          case 'user-voice':
            parts.push(
              item.type === 'user-voice'
                ? `WRITE IN THIS AUTHOR'S VOICE (mirror the style and any sample writings below closely; do not invent facts):\n${item.body}`
                : `About the author:\n${item.body}`,
            );
            break;
          case 'firm-identity':
            parts.push(
              `Firm ${item.type === 'firm-soul' ? 'identity (Firm Soul)' : 'direction (Firm Compass)'}:\n${item.body}`,
            );
            break;
          case 'client-people':
            parts.push(`Client relationships & commitments (from memory):\n${item.body}`);
            break;
          default:
            parts.push(`Client strategic memory (${item.type}):\n${item.body}`);
        }
      }
      return parts.length ? parts.join('\n\n') : null;
    } catch (error) {
      rethrowRequiredContextPersistence(error);
      return null;
    }
  };

  const generateDraft = methods.generateOutreachDraft.bind(service);
  const generateBatch = methods.generateBatchEmails.bind(service);
  methods.generateOutreachDraft = ((...args: Parameters<GenerateDraft>) =>
    boundary.guard(() => generateDraft(...args))) as GenerateDraft;
  methods.generateBatchEmails = ((...args: Parameters<GenerateBatch>) =>
    boundary.guard(() => generateBatch(...args))) as GenerateBatch;

  return guardEngagementServiceRuntime(service, runtimePolicy);
}

export function guardEngagementServiceRuntime(
  service: EngagementService,
  runtimePolicy: EngagementRuntimePolicyService,
): EngagementService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const metadata = RUNTIME_ACTION_BY_METHOD[property];
      if (!metadata) return value.bind(target);
      return (...args: unknown[]) => {
        runtimePolicy.assertExternalAction(metadata.action, {
          testMode: metadata.testMode,
        });
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function guardedEngagementServiceMethods(): Readonly<
  Record<string, { action: EngagementExternalAction; testMode?: boolean }>
> {
  return RUNTIME_ACTION_BY_METHOD;
}
