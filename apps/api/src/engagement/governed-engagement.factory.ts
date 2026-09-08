import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { EngagementService } from './engagement.service.js';
import { MeetingContextPlaneService } from './meeting-context-plane.service.js';
import {
  currentMeetingGovernedContext,
  runWithMeetingGovernedContext,
} from './meeting-context-runtime.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import type { EngagementExternalAction } from './runtime/engagement-runtime.types.js';

export const RAW_ENGAGEMENT_SERVICE = Symbol('RAW_ENGAGEMENT_SERVICE');

type GenerateDraft = EngagementService['generateOutreachDraft'];
type GenerateBatch = EngagementService['generateBatchEmails'];
type GenerateMeetingPrep = EngagementService['generateMeetingPrep'];
type GenerateMeetingDebrief = EngagementService['generateMeetingDebriefDraft'];

interface GovernedEngagementMethods {
  loadUserVoiceBlock: (ctx: TenantContext, clientId: string | null) => Promise<string | null>;
  generateOutreachDraft: GenerateDraft;
  generateBatchEmails: GenerateBatch;
  generateMeetingPrep: GenerateMeetingPrep;
  generateMeetingDebriefDraft: GenerateMeetingDebrief;
}

interface RuntimeMethodMetadata {
  action: EngagementExternalAction;
  testMode?: boolean;
}

const RUNTIME_ACTION_BY_METHOD: Readonly<Record<string, RuntimeMethodMetadata>> = {
  previewAiTemplate: { action: 'outreach_generate' },
  generateTalkingPoints: { action: 'outreach_generate' },
  generateBatchEmails: { action: 'outreach_generate' },
  generateOutreachDraft: { action: 'outreach_generate' },
  generateCampaignEmail: { action: 'outreach_generate' },
  generateMeetingPrep: { action: 'meeting_prep_generate' },
  generateMeetingDebriefDraft: { action: 'meeting_debrief_generate' },
  sendBatchEmails: { action: 'outreach_send' },
  sendCampaign: { action: 'outreach_send' },
  sendCampaignEmails: { action: 'outreach_send' },
  sendCampaignTest: { action: 'outreach_test_send', testMode: true },
  createAttachmentUploadUrl: { action: 'attachment_external_write' },
  confirmAttachment: { action: 'attachment_external_write' },
  createAttachmentFromBuffer: { action: 'attachment_external_write' },
  supersedeAttachment: { action: 'attachment_external_write' },
  deleteAttachment: { action: 'attachment_external_write' },
  eraseAttachmentAsSystem: { action: 'attachment_external_write' },
  reconcileFailedAttachmentDeletes: { action: 'attachment_external_write' },
  extractAttachmentText: { action: 'attachment_external_read' },
  readAttachmentBytes: { action: 'attachment_external_read' },
};

function activeMainRuntimePolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'api',
    processMode: 'active',
    backgroundOwner: 'api',
    externalActions: 'enabled',
    callbacksEnabled: true,
    recallWebhookEnabled: true,
  });
}

/**
 * Preserve the existing EngagementService implementation while hardening the
 * exact context-loader and externally sensitive public entry points.
 *
 * Phase 24 adds a prep/debrief boundary here because this is the common public
 * seam used by controllers, workers, and the notes-first notetaker pipeline. One
 * Context Plane bundle is resolved before any prep/debrief write or provider
 * call, kept request-local with AsyncLocalStorage, and consumed by both the
 * legacy steering helper and the governed EngagementAiService provider seam.
 */
export function createGovernedEngagementService(
  service: EngagementService,
  boundary: ContextPersistenceBoundaryService,
  meetingContext: MeetingContextPlaneService,
  runtimePolicy: EngagementRuntimePolicyService = activeMainRuntimePolicy(),
): EngagementService {
  const methods = service as unknown as GovernedEngagementMethods;

  methods.loadUserVoiceBlock = async (ctx, clientId) => {
    const activeMeeting = currentMeetingGovernedContext();
    if (activeMeeting) {
      if ((clientId ?? null) !== activeMeeting.clientId) {
        throw new Error('phase24_meeting_context_legacy_loader_client_mismatch');
      }
      // The shared packet is authoritative for meeting steering. Do not compile
      // another ContextPacket through the historical helper during this run.
      return activeMeeting.modelContextBlock;
    }

    /**
     * Phase 26 retired the legacy Outreach generation path. Every Outreach draft
     * now runs through GenerationGatewayService, which resolves its own governed
     * ContextPacket via OutreachContextPlaneService — it never calls this legacy
     * steering helper. Reaching this line therefore means some caller found a
     * route to the provider that does not hold a governed bundle, which is
     * exactly the bypass this phase removed. Fail closed rather than compiling a
     * second, ungoverned ContextPacket.
     */
    throw new Error('phase26_engagement_context_plane_required');
  };

  const generateDraft = methods.generateOutreachDraft.bind(service);
  const generateBatch = methods.generateBatchEmails.bind(service);
  const generateMeetingPrep = methods.generateMeetingPrep.bind(service);
  const generateMeetingDebrief = methods.generateMeetingDebriefDraft.bind(service);

  methods.generateOutreachDraft = ((...args: Parameters<GenerateDraft>) =>
    boundary.guard(() => generateDraft(...args))) as GenerateDraft;
  methods.generateBatchEmails = ((...args: Parameters<GenerateBatch>) =>
    boundary.guard(() => generateBatch(...args))) as GenerateBatch;

  methods.generateMeetingPrep = (async (
    ctx: TenantContext,
    meetingId: string,
    additionalContext?: string,
  ) => {
    const bundle = await meetingContext.resolve(ctx, {
      meetingId,
      mode: 'prep',
      userInstruction: additionalContext ?? null,
    });
    return runWithMeetingGovernedContext(bundle, () =>
      boundary.guard(() => generateMeetingPrep(ctx, meetingId, additionalContext)),
    );
  }) as GenerateMeetingPrep;

  methods.generateMeetingDebriefDraft = (async (
    ctx: TenantContext,
    meetingId: string,
    input: Parameters<GenerateMeetingDebrief>[2],
  ) => {
    // Match the raw service's validation before doing retrieval or durable
    // packet work. An invalid request must not create a packet/audit trail or
    // spend any provider/context-plane capacity.
    if (!input?.sourceText?.trim()) {
      throw new BadRequestException('sourceText is required');
    }
    const bundle = await meetingContext.resolve(ctx, {
      meetingId,
      mode: 'debrief',
      sourceMethod: input.method,
    });
    return runWithMeetingGovernedContext(bundle, () =>
      boundary.guard(() => generateMeetingDebrief(ctx, meetingId, input)),
    );
  }) as GenerateMeetingDebrief;

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
  Record<string, RuntimeMethodMetadata>
> {
  return RUNTIME_ACTION_BY_METHOD;
}
