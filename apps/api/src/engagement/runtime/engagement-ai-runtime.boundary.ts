import type { AiCredentialResolverService } from '../ai-credential-resolver.service.js';
import type { EngagementAiService } from '../engagement-ai.service.js';
import type { EngagementExternalAction } from './engagement-runtime.types.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

export const RAW_AI_CREDENTIAL_RESOLVER_SERVICE = Symbol(
  'RAW_AI_CREDENTIAL_RESOLVER_SERVICE',
);

const AI_ACTION_BY_METHOD = {
  generateMeetingPrep: 'meeting_prep_generate',
  generateMeetingDebrief: 'meeting_debrief_generate',
  generateOutreachDraft: 'outreach_generate',
  generateTalkingPoints: 'outreach_generate',
  generateCampaignEmail: 'outreach_generate',
  resolveOutreachCredentials: 'outreach_generate',
} as const satisfies Readonly<Record<string, EngagementExternalAction>>;

const CREDENTIAL_ACTION_BY_METHOD = {
  resolveOrder: 'internal_ai_credential_resolve',
  resolveProvider: 'internal_ai_credential_resolve',
  resolveProviderByTenantId: 'internal_ai_credential_resolve',
  validateKey: 'internal_ai_credential_resolve',
} as const satisfies Readonly<Record<string, EngagementExternalAction>>;

function guardMethods<T extends object>(
  service: T,
  policy: EngagementRuntimePolicyService,
  methods: Readonly<Record<string, EngagementExternalAction>>,
): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const action = methods[property];
      if (!action) return value.bind(target);
      return (...args: unknown[]) => {
        policy.assertExternalAction(action);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

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
  return guardMethods(service, policy, AI_ACTION_BY_METHOD);
}

/**
 * Keep decrypted tenant keys and provider key-validation requests behind the
 * same runtime boundary. This protects internal service callers independently
 * of the `internal/ai-credentials/resolve` controller guard.
 */
export function guardAiCredentialResolverService(
  service: AiCredentialResolverService,
  policy: EngagementRuntimePolicyService,
): AiCredentialResolverService {
  return guardMethods(service, policy, CREDENTIAL_ACTION_BY_METHOD);
}

export function guardedEngagementAiMethods(): Readonly<
  Record<string, EngagementExternalAction>
> {
  return AI_ACTION_BY_METHOD;
}

export function guardedCredentialResolverMethods(): Readonly<
  Record<string, EngagementExternalAction>
> {
  return CREDENTIAL_ACTION_BY_METHOD;
}
