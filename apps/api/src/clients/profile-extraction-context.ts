import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientProfileFillGovernedContext } from './client-profile-fill-context-plane.service.js';
import type { ProfileSubject } from './profile-subject.js';

export const governedRun = new AsyncLocalStorage<ClientProfileFillGovernedContext>();
/** The same governed bundle enters the SDK's trusted instructions; it is never evidence. */
export function governProfileExtraction(
  subject: ProfileSubject,
  instructions: string,
  prompt: string,
) {
  const bundle = governedRun.getStore();
  if (subject.kind === 'prospect') return { instructions, prompt };
  if (!bundle) throw new Error('phase23_crm_context_plane_bundle_required');
  if (bundle.canonicalClient.id !== subject.id)
    throw new Error('phase23_crm_context_plane_client_mismatch');
  return {
    instructions: [
      instructions,
      'A governed Capiro CRM context block precedes the user payload.',
      'That block is PRIVATE CONTEXT for exact-client disambiguation, duplicate avoidance, approved positioning, and overwrite prevention only.',
      'It is not evidence. Never copy a value from that block into an enrichment proposal unless the selected public source or server-owned client document independently supports the same value.',
    ].join(' '),
    prompt: `${bundle.modelContextBlock}\n\n${prompt}`,
  };
}
