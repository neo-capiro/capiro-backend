export const MERI_PERSISTED_POLICY_PACKS_DISABLED = true;

/**
 * Persisted tenant policy packs are intentionally disabled for the Meri API
 * runtime. Meri's ordinary tool approval boundary remains in place, but a
 * missing or unpublished tenant policy pack must not block an otherwise valid
 * action such as generating a Word document.
 *
 * This override is applied before Nest constructs the Meri providers so a
 * stale deployment value such as MERI_POLICY_PACK_SOURCE=enforce cannot restore
 * fail-closed policy-pack behavior accidentally.
 */
export function disablePersistedMeriPolicyPackEnforcement(
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.MERI_POLICY_PACK_SOURCE = 'off';
}
