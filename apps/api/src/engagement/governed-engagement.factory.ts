import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { EngagementService } from './engagement.service.js';

export const RAW_ENGAGEMENT_SERVICE = Symbol('RAW_ENGAGEMENT_SERVICE');

type GenerateDraft = EngagementService['generateOutreachDraft'];
type GenerateBatch = EngagementService['generateBatchEmails'];

interface GovernedEngagementMethods {
  generateOutreachDraft: GenerateDraft;
  generateBatchEmails: GenerateBatch;
}

/**
 * Preserve the existing EngagementService implementation while surrounding the
 * two externally rendered generation entry points with a request/job-local
 * persistence boundary. This covers both synchronous HTTP generation and the
 * async OutreachJobService worker, which calls generateBatchEmails off-request.
 */
export function createGovernedEngagementService(
  service: EngagementService,
  boundary: ContextPersistenceBoundaryService,
): EngagementService {
  const methods = service as unknown as GovernedEngagementMethods;
  const generateDraft = methods.generateOutreachDraft.bind(service);
  const generateBatch = methods.generateBatchEmails.bind(service);

  methods.generateOutreachDraft = ((...args: Parameters<GenerateDraft>) =>
    boundary.guard(() => generateDraft(...args))) as GenerateDraft;
  methods.generateBatchEmails = ((...args: Parameters<GenerateBatch>) =>
    boundary.guard(() => generateBatch(...args))) as GenerateBatch;

  return service;
}
