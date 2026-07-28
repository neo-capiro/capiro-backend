export interface MeriV2FullChatRoutingInput {
  bearerToken?: string | null;
  configured: boolean;
  enabled: boolean;
  impersonateTenantId?: string | null;
}

/**
 * Phase 0 containment: impersonated turns cannot enter MeriV2 until Phase 1
 * carries one unified effective actor/tenant/impersonation context end-to-end.
 */
export function shouldRouteMeriV2FullChat(input: MeriV2FullChatRoutingInput): boolean {
  return Boolean(
    input.bearerToken &&
      input.configured &&
      input.enabled &&
      !input.impersonateTenantId?.trim(),
  );
}
