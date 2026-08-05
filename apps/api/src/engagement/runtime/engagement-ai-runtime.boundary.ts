import type { EngagementAiService } from '../engagement-ai.service.js';
import type { EngagementExternalAction } from './engagement-runtime.types.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

const AI_ACTION_BY_METHOD: Readonly<Record<string, EngagementExternalAction>> = {
  generateMeetingPrep: 'meeting_prep_generate',
  generateMeetingDebrief: 'meeting_debrief_generate',
  generateOutreachDraft: 'outreach_generate',
  generateTalkingPoints: 'outreach_generate',
  generateCampaignEmail: 'outreach_generate',
  resolveOutreachCredentials: 'outreach_generate',
};

/**
 * Wrap the existing Engagement AI implementation with a service-boundary guard.
 *
 * Controller metadata remains the first line of defense, but EngagementService,
 * workers, tests, or future internal callers can invoke EngagementAiService
 * directly. The wrapped service asserts the runtime policy before any method body
 * can resolve credentials, enrich context, create an unguarded completion client,
 * or call a provider directly.
 */
export function guardEngagementAiService(
  service: EngagementAiService,
  policy: EngagementRuntimePolicyService,
): EngagementAiService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const action = AI_ACTION_BY_METHOD[property];
      if (!action) return value.bind(target);
      return (...args: unknown[]) => {
        policy.assertExternalAction(action);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function guardedEngagementAiMethods(): Readonly<
  Record<string, EngagementExternalAction>
> {
  return AI_ACTION_BY_METHOD;
}
