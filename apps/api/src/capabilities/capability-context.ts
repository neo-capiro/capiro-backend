export type CapabilitySurface =
  | 'meri_chat'
  | 'outreach'
  | 'workspace'
  | 'strategy'
  | 'internal';

export interface AuthorizedCapabilityContext {
  actorUserId: string;
  clerkUserId?: string;
  tenantId: string;
  tenantSlug?: string;
  role: string;
  clientScope?: {
    clientId: string;
    reason: 'explicit' | 'campaign' | 'surface' | 'authorized_inference';
  } | null;
  impersonation?: {
    sessionId: string;
    actorUserId: string;
    effectiveTenantId: string;
  } | null;
  requestId: string;
  surface: CapabilitySurface;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertAuthorizedCapabilityContext(
  value: unknown,
): asserts value is AuthorizedCapabilityContext {
  if (!value || typeof value !== 'object') throw new Error('capability context is required');
  const ctx = value as Partial<AuthorizedCapabilityContext>;
  if (!ctx.tenantId || !UUID_RE.test(ctx.tenantId)) throw new Error('invalid tenant context');
  if (!ctx.actorUserId || !UUID_RE.test(ctx.actorUserId)) throw new Error('invalid actor context');
  if (!ctx.requestId || typeof ctx.requestId !== 'string') throw new Error('requestId is required');
  if (!ctx.role || typeof ctx.role !== 'string') throw new Error('role is required');
  if (!['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'].includes(String(ctx.surface))) {
    throw new Error('invalid capability surface');
  }
  if (ctx.clientScope && !UUID_RE.test(ctx.clientScope.clientId)) {
    throw new Error('invalid client scope');
  }
  if (
    ctx.impersonation &&
    (ctx.impersonation.effectiveTenantId !== ctx.tenantId ||
      ctx.impersonation.actorUserId !== ctx.actorUserId)
  ) {
    throw new Error('invalid impersonation context');
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
