import type { TenantContext } from '@capiro/shared';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { rethrowRequiredContextPersistence } from '../context/context-required-persistence.js';
import { EngagementService } from './engagement.service.js';

export const RAW_ENGAGEMENT_SERVICE = Symbol('RAW_ENGAGEMENT_SERVICE');

type GenerateDraft = EngagementService['generateOutreachDraft'];
type GenerateBatch = EngagementService['generateBatchEmails'];

interface GovernedEngagementMethods {
  loadUserVoiceBlock: (ctx: TenantContext, clientId: string | null) => Promise<string | null>;
  generateOutreachDraft: GenerateDraft;
  generateBatchEmails: GenerateBatch;
}

/**
 * Preserve the existing EngagementService implementation while hardening the
 * exact context-loader and the two externally rendered generation entry points.
 *
 * Replacing the loader means a required Context Packet persistence error escapes
 * before any model call or draft/version write. Ordinary context outages retain
 * the historical best-effort fallback. The public method guards also cover the
 * async OutreachJobService worker and any future fail-soft catch added later.
 */
export function createGovernedEngagementService(
  service: EngagementService,
  boundary: ContextPersistenceBoundaryService,
  contextCompiler: ContextCompilerService,
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

  return service;
}
