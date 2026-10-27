// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or anything touching Clerk auth, the tenant-context
// middleware, JWT/session handling, Microsoft Graph OAuth, the Clerk webhook,
// or integration connection/token persistence) without EXPLICIT prior approval
// from Neo. These paths gate every authenticated request and the email/Outlook
// integration; a subtle change here has repeatedly caused tenant-wide 403/500
// outages (see git history 2026-06-07 + skill: capiro-tenant-onboarding-flow).
// Investigate read-only and PROPOSE first; wait for go-ahead before editing,
// merging, or deploying.
// ============================================================================
import { mountedRequestPath } from '../auth/mounted-request-path.js';
import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NestMiddleware,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import {
  authDeniedEvent,
  ROLE_RANK,
  TENANT_HEADER,
  type AuthDeniedReason,
  type TenantContext,
  type TenantRole,
} from '@capiro/shared';
import { readCoreEd25519KeyConfig, readMeriExecutionIdentity } from '../auth/core-ed25519-key-config.js';
import {
  isMeriExecutionCapabilityPost,
  isMeriRoutineUnattendedGrantPost,
  markMeriExecutionRequest,
} from '../auth/meri-execution-request.js';
import { ClerkService, isWellFormedMeriControlCredentialClaims, type ClerkSessionClaims, type ActiveApplicationAuthoritySession } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { mapClerkRoleToCapiro } from '../auth/clerk-role.util.js';
import { TenantContextStore } from './tenant-context.store.js';
import {
  applicationAuthorityRevision,
  type ApplicationAuthorityIdentityEvidence,
  type ApplicationAuthorityIdentityProof,
} from '../auth/application-authority.js';
import { coreRosterPreviewDecision, firstChatClientPreviewDecision, isPreviewNativeReadRoute, previewNativeReadMode } from '../auth/preview-native-read-mode.js';
import {
  admitMeriReadToken,
  isMeriReadDelegationServicePost,
  isMeriReadTokenRequest,
} from '../auth/read-delegation/read-delegation-request.js';
import {
  isSignedMemoryHelperPost, isSignedMemoryPagePost, isSignedMemoryProposalPost,
  signedMemoryPageEnabled, signedMemoryProposalEnabled,
} from '../auth/read-delegation/signed-memory-http-gate.js';
import {
  captureRetainedNativeAuthority,
  requiresVerifiedRetainedNativeAuthority,
  type RetainedNativeAuthorityCapture,
  type RetainedNativeAuthorityCurrent,
  type VerifiedRetainedNativeAuthority,
} from '../auth/retained-native-authority.js';

type SystemTx = Prisma.TransactionClient;
type MembershipWithTenant = Prisma.TenantMembershipGetPayload<{ include: { tenant: true } }>;

interface ApplicationAuthorityRequestProvenance {
  context: TenantContext;
  claims: ClerkSessionClaims;
  membershipId: string;
  membershipTenantId: string;
  requestedSlug: string | undefined;
  impersonationId: string | null;
}

// Nest's middleware wrapper and injected provider can be separate instances.
// The existing owner shares only private, ephemeral provenance keyed by the
// actual request object; there is no reusable/durable authorization receipt.
const applicationAuthorityRequests = new WeakMap<Request, ApplicationAuthorityRequestProvenance>();
const MERI_CONTROL_POST_PATHS = new Set([
  '/engagement/outreach/sdk/claim',
  '/engagement/outreach/sdk/read',
  '/engagement/outreach/sdk/complete',
  '/engagement/outreach/sdk/fail',
  '/clio/application-authority/identity',
  '/clio/application-authority/context',
  '/clio/application-authority/membership',
  '/clio/application-authority/current',
]);

/** A marked, sidless Meri control token is limited to allowlisted authority POSTs.
 * Check both Express' parsed path and the original target: a rewritten or
 * absolute-form target must never widen the credential's route authority. */
function isMeriControlAuthorityPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const parsed = mountedRequestPath(req);
  const original = (req.originalUrl ?? req.url ?? '').split('?')[0];
  const normalized = (path: string) => path.startsWith('/api/') ? path.slice(4) : path;
  return parsed === original && MERI_CONTROL_POST_PATHS.has(normalized(parsed));
}

/** Only authenticated middleware provenance can choose an authority user key. */
export function applicationAuthorityThrottleKey(req: Request): string | null {
  if (!isMeriControlAuthorityPost(req)) return null;
  const provenance = applicationAuthorityRequests.get(req);
  return provenance ? `authority-user:${provenance.claims.sub}` : null;
}

// Signed retained-read routes authenticate with a Core-issued Ed25519 envelope,
// never a Clerk Bearer. Each fixed POST accepts exactly one scheme.
const RETAINED_SIGNED_POSTS = new Map([
  ['/clio/retained-reads/research-portfolio', 'CapiroRetained'],
  ['/clio/retained-reads/research-portfolio-changes', 'CapiroRetained'],
  ['/clio/application-authority/retained-florida-current', 'CapiroRetained'],
  ['/clio/application-authority/retained-florida-native-current', 'CapiroRetainedAuthority'],
]);

/** Admits a signed retained POST past Bearer verification only while retained
 * reads are enabled, when the parsed and original targets are the same exact
 * fixed path, and when the Authorization scheme is the one that path accepts.
 * No tenant context is created here: the controller verifies the pinned
 * signature and freshly rechecks native and resource authority before any read,
 * and refuses (503) when trust is not configured. */
function isRetainedSignedPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const parsed = mountedRequestPath(req);
  const original = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (parsed !== original) return false;
  const scheme = RETAINED_SIGNED_POSTS.get(parsed.startsWith('/api/') ? parsed.slice(4) : parsed);
  const header = req.headers.authorization;
  if (!scheme || typeof header !== 'string') return false;
  const space = header.indexOf(' ');
  if (space <= 0 || header.slice(0, space) !== scheme || header.length === space + 1 ||
      header.includes(' ', space + 1)) return false;
  return typeof process !== 'undefined' && process.env.RETAINED_READS_ENABLED === 'true';
}

/**
 * Resolves the tenant context for an authenticated request.
 *
 * Order of operations:
 *   1. Verify the Clerk session JWT (Authorization: Bearer ...).
 *   2. Resolve the requested tenant. Preference order:
 *        a. `capiro_tenant_id` from the Clerk JWT template (fast path, no
 *            membership scan needed; the org_id claim is cross-checked
 *            against tenants.clerk_org_id).
 *        b. X-Capiro-Tenant header.
 *        c. Subdomain match, `{slug}.app.capiro.ai`.
 *        d. Sole-membership fallback, if the user has exactly one active
 *            membership and none of the above produced a hint, use it.
 *   3. Look up the membership using RLS bypass (the lookup itself is not
 *      tenant-scoped because we are still resolving which tenant to use).
 *   4. Cross-check: if the JWT carries `org_id`, the resolved tenant's
 *      `clerk_org_id` MUST match. Mismatch → 403.
 *   5. Propagate the context via AsyncLocalStorage + req.tenantContext.
 *
 * This is the JWT/host integrity check called out in arch §2.2 and §8.2.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
    private readonly store: TenantContextStore,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // This mirror is first so neither signed-service bypasses nor the ordinary
    // Clerk resolver can run on the reserved roster Host, even if process
    // registration changes. The main bootstrap gate also covers excluded paths.
    const roster = coreRosterPreviewDecision(
      req,
      process.env.CORE_ROSTER_PREVIEW_ENABLED === 'true',
      process.env.PREVIEW_NATIVE_GETS_ENABLED === 'true',
    );
    if (roster !== 'unrelated') {
      res.setHeader('Cache-Control', 'no-store');
      if (roster === 'unavailable') throw new ServiceUnavailableException('Preview reads unavailable');
      if (roster === 'not-found') throw new NotFoundException();
      await this.usePreviewNativeRead(req, next);
      return;
    }
    const clientPreview = firstChatClientPreviewDecision(req, process.env.PREVIEW_NATIVE_GETS_ENABLED === 'true');
    if (clientPreview !== 'unrelated') {
      res.setHeader('Cache-Control', 'no-store');
      if (clientPreview === 'unavailable') throw new ServiceUnavailableException('Preview client records unavailable');
      if (clientPreview === 'not-found') throw new NotFoundException();
      await this.usePreviewNativeRead(req, next);
      return;
    }
    // Also cover authentication/authorization denials before the controller.
    const authorityPaths = [
      '/api/clio/application-authority/history-release', '/clio/application-authority/history-release',
      '/api/clio/application-authority/identity', '/api/clio/application-authority/context',
      '/clio/application-authority/identity', '/clio/application-authority/context',
      '/api/clio/application-authority/membership', '/clio/application-authority/membership',
      '/api/clio/application-authority/current', '/clio/application-authority/current',
      '/api/clio/application-authority/retained-research-portfolio', '/clio/application-authority/retained-research-portfolio',
      '/api/clio/application-authority/retained-research-portfolio-changes', '/clio/application-authority/retained-research-portfolio-changes',
      '/api/clio/application-authority/retained-florida-budget', '/clio/application-authority/retained-florida-budget',
      '/api/clio/application-authority/retained-research-portfolio-principal', '/clio/application-authority/retained-research-portfolio-principal',
      '/api/clio/application-authority/retained-research-portfolio-changes-principal', '/clio/application-authority/retained-research-portfolio-changes-principal',
      '/api/clio/application-authority/retained-florida-principal', '/clio/application-authority/retained-florida-principal',
      '/api/clio/application-authority/retained-florida-native-current', '/clio/application-authority/retained-florida-native-current',
      '/api/clio/application-authority/retained-florida-current', '/clio/application-authority/retained-florida-current',
      '/api/clio/retained-reads/research-portfolio', '/clio/retained-reads/research-portfolio',
      '/api/clio/retained-reads/research-portfolio-changes', '/clio/retained-reads/research-portfolio-changes',
    ];
    if ([req.path, (req.originalUrl ?? req.url ?? '').split('?')[0]].some(
      // Express defaults accept case variants and one trailing slash. Cover
      // those same handler spellings on pre-controller authentication denials.
      (path) => path !== undefined && authorityPaths.includes(path.replace(/\/$/, '').toLowerCase()),
    )) res.setHeader('Cache-Control', 'no-store');
    if (isRetainedSignedPost(req)) {
      next();
      return;
    }
    // Meri's approved-execution capability (D016 #9) on its single receiver
    // route. Never a fallback for any other path or token type.
    if (isMeriExecutionCapabilityPost(req)) {
      res.setHeader('Cache-Control', 'no-store');
      await this.useMeriExecutionCapability(req, next);
      return;
    }
    // Meri's unattended routine firing grant (wire C, D016-A item 5): the
    // service identity alone, no bearer and no tenant context; the controller
    // requires the verified service identity and answers only from the
    // owner's stored consent. Exact path and method only.
    if (isMeriRoutineUnattendedGrantPost(req)) {
      res.setHeader('Cache-Control', 'no-store');
      next();
      return;
    }
    // Run-bound read delegation (RC1 option B, D016-A item 4). A
    // `CapiroMeriRead` token is admitted ONLY on its own target (signature,
    // exact path and body bytes, single-use jti, Meri run facts, member); it
    // never falls through to Clerk verification or to another route. The
    // bearer-less service POSTs (unattended create, tokens, revocations,
    // consent narrowing) get no tenant context; their controller requires the
    // verified service identity. Exact paths and method only.
    if (isMeriReadTokenRequest(req)) {
      res.setHeader('Cache-Control', 'no-store');
      // One-use source tokens must refuse before ordinary admission consumes
      // their JTI while the corresponding fixed receiver is held. The helper
      // has a distinct signed type and is verified/consumed only by its fixed
      // controller, never by admitMeriReadToken or Clerk provisioning.
      if (isSignedMemoryHelperPost(req)) {
        if (!signedMemoryPageEnabled()) throw new ServiceUnavailableException('Passive memory helper unavailable');
        next();
        return;
      }
      if (isSignedMemoryPagePost(req) && !signedMemoryPageEnabled())
        throw new ServiceUnavailableException('Passive memory page unavailable');
      if (isSignedMemoryProposalPost(req) && !signedMemoryProposalEnabled())
        throw new ServiceUnavailableException('Memory proposal page unavailable');
      await this.useMeriReadDelegation(req, next);
      return;
    }
    if (isMeriReadDelegationServicePost(req)) {
      res.setHeader('Cache-Control', 'no-store');
      next();
      return;
    }
    // Belt-and-suspenders bypass for paths that authenticate via a different
    // channel than the Clerk session. The OAuth callback is reached via a
    // top-level browser redirect from Microsoft and authenticates via the
    // HMAC-signed `state` parameter. Public marketing lead capture has no
    // tenant context by design. The middleware-level `.exclude()` in
    // app.module.ts is the primary mechanism; this is the fallback in case the
    // exclude path matcher misses for any reason (e.g. global prefix
    // interaction).
    const path = req.path;
    const originalUrl = req.originalUrl ?? req.url ?? '';
    const baseUrl = req.baseUrl ?? '';
    const bypassPaths = [
      '/webhooks/clerk',
      '/api/v1/demo-requests',
      '/api/engagement/integrations/microsoft/callback',
      '/api/engagement/integrations/microsoft/notifications',
      // Google OAuth callback: same pattern as the Microsoft callback above — a
      // top-level browser redirect from Google with ?code&state and no Clerk
      // session; authenticates via the HMAC-signed `state`
      // (GoogleOAuthService.verifyState). (Google push notifications endpoint is
      // added here in Phase 3 when users.watch/Pub/Sub lands.)
      '/api/engagement/integrations/google/callback',
      '/api/clio/runtime',
      '/api/clio/mcp-oauth/callback',
      '/api/insights',
      // Recipient capabilities authorize these routes; no private newsletter
      // authoring endpoint is covered by this distinct public prefix.
      '/api/engagement/newsletter-public',
      // BYOK3 service-to-service endpoints: intel-api resolves a tenant AI
      // credential for live-hearing extraction. These authenticate via
      // InternalServiceGuard (shared INTERNAL_SERVICE_SECRET header), NOT a
      // Clerk session, so they carry no bearer token and must bypass tenant
      // resolution here (the guard reads tenantId from the body). The
      // app.module.ts `.exclude()` misses because setGlobalPrefix('api')
      // shifts the matcher — this internal list is the mechanism that works.
      '/api/internal',
      // Research Portfolio client share links: authorized by the link token and the
      // portfolio PIN (ResearchPortfolioShareService), never by a Clerk session.
      '/api/public/research-share',
    ];
    if (bypassPaths.some((bypassPath) => isBypassPath(bypassPath, path, originalUrl, baseUrl))) {
      if (!originalUrl.includes('/newsletter-public/') &&
          !isBypassPath('/api/public/research-share', path, originalUrl, baseUrl)) this.logger.log(
        `Bypassing tenant context for public/external route (path=${path}, originalUrl=${originalUrl}, baseUrl=${baseUrl})`,
      );
      next();
      return;
    }

    // The preview's native GETs must not pass through the ordinary provisioning,
    // identity-rebind, membership self-heal or lastSeenAt write path. Resolve an
    // existing native member only; the same request is checked again at release.
    if (isPreviewNativeReadRoute(req)) {
      const mode = previewNativeReadMode(
        process.env.PREVIEW_NATIVE_GETS_ENABLED === 'true', req.headers.host,
        process.env.CORE_ROSTER_PREVIEW_ENABLED === 'true',
      );
      if (mode !== 'ordinary') {
        res.setHeader('Cache-Control', 'no-store');
        if (mode === 'unavailable') throw new ServiceUnavailableException('Preview reads unavailable');
        await this.usePreviewNativeRead(req, next);
        return;
      }
    }

    // Step 1, verify Clerk JWT.
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = auth.slice('bearer '.length).trim();

    let claims: ClerkSessionClaims;
    try {
      claims = await this.clerk.verifySessionToken(token);
    } catch {
      throw new UnauthorizedException('Invalid session token');
    }
    // A valid dedicated control template is not a general browser credential.
    // Refuse it before ordinary tenant lookup, self-heal or lastSeenAt writes.
    if (claims.meri_control_credential === true) {
      if (!isMeriControlAuthorityPost(req) || !isWellFormedMeriControlCredentialClaims(claims)) {
        throw new UnauthorizedException('Application authority unavailable');
      }
      // The ordinary context resolver can write during membership self-heal.
      // Refuse a revoked control credential before that first local DB action.
      // The authority owner checks again after resolution and on each later
      // read. Clerk may reuse positive session evidence for at most five seconds;
      // local authority is always re-read and never cached.
      await this.clerk.assertActiveMeriControlCredentialSession(claims);
    }

    // Step 2, gather every hint we have about which tenant is being requested.
    // Empty strings from the JWT template (when the user has no active org)
    // are normalized to undefined so the downstream logic only sees real
    // signals.
    const requestedSlug = this.resolveRequestedTenantSlug(req);
    const claimedTenantId = nonEmpty(claims.capiro_tenant_id);
    const claimedTenantSlug = nonEmpty(claims.capiro_tenant_slug);
    const claimedOrgId = nonEmpty(claims.org_id);

    // Denial capture. Set immediately before each 403 throw and consumed AFTER
    // the transaction has unwound — see the catch below for why it cannot be
    // recorded inline.
    let denial: {
      reason: AuthDeniedReason;
      tenantId?: string | null;
      claimedTenantId?: string | null;
    } | null = null;
    let selectedAuthorityMembership: { id: string; tenantId: string } | undefined;
    let selectedAuthorityImpersonation: string | null = null;

    // Step 3, resolve membership using RLS bypass. The lookup is not
    // tenant-scoped (we are still resolving the tenant), so it MUST run
    // through the system path.
    const resolveContext = () => this.prisma.withSystem(async (tx) => {
      let user = await tx.user.findUnique({ where: { clerkUserId: claims.sub } });
      if (!user) {
        // First-time authenticated request from this Clerk user. The webhook is
        // the canonical source of users, but a slow (or, as in the 2026-05
        // webhook-routing outage, undelivered) webhook must not block a user
        // whose verified Clerk JWT already proves their identity.
        //
        // A row may already exist for this email — e.g. created by an earlier
        // flow with a different/placeholder clerkUserId, or by an out-of-order
        // webhook. Adopt it and bind it to this verified Clerk identity rather
        // than INSERTing a duplicate, which would violate the unique email
        // constraint and 500 every request. Verified-JWT email is authoritative.
        const email = claims.email ?? `${claims.sub}@unknown.invalid`;
        const existingByEmail = await tx.user.findUnique({ where: { email } });
        if (existingByEmail) {
          // IDENTITY REBIND. An existing local row is being re-pointed at a
          // different Clerk identity on the strength of an email match alone.
          // That is usually right (an old placeholder row, an out-of-order
          // webhook) but it is not PROOF the two Clerk identities are the same
          // person: a stale row whose user.deleted webhook never landed would
          // hand its memberships to whoever next signs up with that address.
          //
          // Recorded, not blocked. Gating this would break the self-heal path
          // whose whole purpose is preventing lockouts when the webhook is slow
          // or undelivered, and there is no telemetry yet on how often it
          // legitimately fires. Populate the ledger, review it, then decide.
          // Emit a structured security event ONLY — deliberately no database
          // write on this path.
          //
          // This runs inside the caller's interactive transaction, and a failed
          // INSERT (e.g. the ledger migration not yet applied) would put
          // Postgres into an aborted-transaction state that a JS try/catch
          // cannot recover: the tx.user.update below would then fail too and
          // 500 the login. The webhook and provisioning paths write the
          // UserIdentityConflict row; this one is covered by the log +
          // CloudWatch metric filter, which is the evidence that matters.
          const membershipCount = await tx.tenantMembership.count({
            where: { userId: existingByEmail.id },
          });
          this.logger.warn(
            JSON.stringify({
              security_event: 'identity.rebind',
              source: 'middleware_self_heal',
              email,
              incoming_clerk_user_id: claims.sub,
              previous_clerk_user_id: existingByEmail.clerkUserId,
              membership_count: membershipCount,
              count: 1,
            }),
          );
          user = await tx.user.update({
            where: { id: existingByEmail.id },
            data: { clerkUserId: claims.sub },
          });
        } else {
          user = await tx.user.create({
            data: {
              clerkUserId: claims.sub,
              email,
            },
          });
        }
      }

      let memberships = await tx.tenantMembership.findMany({
        where: { userId: user.id, status: 'active' },
        include: { tenant: true },
      });

      // Match by every hint we have, in preference order. The JWT-claim
      // matches are the fast path: if the Clerk JWT template populated
      // capiro_tenant_id, we trust it (after the org_id cross-check below).
      let chosen: MembershipWithTenant | undefined =
        memberships.find((m) => claimedTenantId && m.tenantId === claimedTenantId) ??
        memberships.find((m) => claimedOrgId && m.tenant.clerkOrgId === claimedOrgId) ??
        memberships.find(
          (m) => claimedTenantSlug && m.tenant.slug === claimedTenantSlug.toLowerCase(),
        ) ??
        memberships.find((m) => requestedSlug && m.tenant.slug === requestedSlug) ??
        // Sole-membership fallback only when no signal at all was supplied.
        (memberships.length === 1 &&
        !claimedTenantId &&
        !claimedOrgId &&
        !claimedTenantSlug &&
        !requestedSlug
          ? memberships[0]
          : undefined);

      // Self-heal. The local tenant_memberships table is a MIRROR of Clerk org
      // memberships, populated asynchronously by the Clerk webhook. If that
      // mirror is missing the row but the cryptographically-verified Clerk JWT
      // asserts an active org membership (org_id claim), provision the row from
      // the trusted claims instead of locking the user out. This is the same
      // trust model the webhook uses (Clerk is the source of truth for org
      // membership); selfHealMembership() never grants access to a tenant the
      // JWT does not already prove membership in, and it refuses to resurrect a
      // membership that was explicitly removed/suspended.
      if (!chosen && claimedOrgId) {
        const healed = await this.selfHealMembership(tx, user.id, {
          claimedOrgId,
          claimedTenantId,
          claimedTenantSlug,
          orgRole: nonEmpty(claims.org_role) ?? nonEmpty(claims.capiro_org_role),
        });
        if (healed) {
          memberships = [...memberships, healed];
          chosen = healed;
          this.logger.warn(
            `Self-healed missing local membership for user ${user.id} in tenant ` +
              `${healed.tenantId} (role ${healed.role}) from a verified Clerk JWT; ` +
              `the webhook-populated mirror was stale.`,
          );
        }
      }

      if (memberships.length === 0) {
        denial = { reason: 'no_active_membership' };
        throw new ForbiddenException('User has no active tenant memberships');
      }

      if (!chosen) {
        denial = { reason: 'no_matching_tenant', claimedTenantId };
        throw new ForbiddenException(
          'No matching tenant for the supplied identifier, re-auth required',
        );
      }

      // Step 4, integrity cross-checks. If the JWT and the resolved tenant
      // disagree on any identifier, force re-auth. Each branch covers a
      // different way an attacker could try to pivot tenants.
      if (claimedTenantId && chosen.tenantId !== claimedTenantId) {
        denial = {
          reason: 'tenant_claim_mismatch',
          tenantId: chosen.tenantId,
          claimedTenantId,
        };
        throw new ForbiddenException('Tenant claim mismatch, re-auth required');
      }
      if (claimedOrgId && chosen.tenant.clerkOrgId !== claimedOrgId) {
        denial = { reason: 'org_claim_mismatch', tenantId: chosen.tenantId, claimedTenantId };
        throw new ForbiddenException('Org claim mismatch, re-auth required');
      }
      if (
        claimedTenantSlug &&
        chosen.tenant.slug.toLowerCase() !== claimedTenantSlug.toLowerCase()
      ) {
        denial = { reason: 'slug_claim_mismatch', tenantId: chosen.tenantId, claimedTenantId };
        throw new ForbiddenException('Tenant slug claim mismatch, re-auth required');
      }
      if (requestedSlug && chosen.tenant.slug !== requestedSlug) {
        denial = { reason: 'host_mismatch', tenantId: chosen.tenantId, claimedTenantId };
        throw new ForbiddenException('Subdomain/header tenant mismatch, re-auth required');
      }
      selectedAuthorityMembership = { id: chosen.id, tenantId: chosen.tenantId };

      // Best-effort last_seen_at update, do not fail the request on error.
      await tx.user
        .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);

      // Impersonation override (capiro_admin only). If the caller is a
      // capiro_admin AND has an active session AND the request carries the
      // x-capiro-impersonate-tenant header, swap the tenant context to the
      // impersonated tenant. Every request executed under impersonation is
      // attributed to the actor (audit_logs.actor_user_id) so reads/writes
      // are traceable.
      const wantsImpersonate = req.header('x-capiro-impersonate-tenant')?.trim().toLowerCase();
      if (wantsImpersonate && chosen.role === 'capiro_admin') {
        const session = await tx.impersonationSession.findFirst({
          where: { actorUserId: user.id, endedAt: null, expiresAt: { gt: new Date() } },
          include: { tenant: true },
        });
        if (!session) {
          throw new ForbiddenException(
            'No active impersonation session, start one via /capiro-admin/impersonate',
          );
        }
        if (session.tenant.slug.toLowerCase() !== wantsImpersonate) {
          throw new ForbiddenException(
            `Impersonation session is for tenant ${session.tenant.slug}, header asks for ${wantsImpersonate}`,
          );
        }
        selectedAuthorityImpersonation = session.id;
        const context: TenantContext = {
          tenantId: session.tenantId,
          tenantSlug: session.tenant.slug,
          userId: user.id,
          clerkUserId: user.clerkUserId,
          role: 'capiro_admin', // role stays, capiro_admin acting as
        };
        return context;
      }

      const context: TenantContext = {
        tenantId: chosen.tenantId,
        tenantSlug: chosen.tenant.slug,
        userId: user.id,
        clerkUserId: user.clerkUserId,
        role: chosen.role as TenantRole,
      };
      return context;
    });

    let ctx: TenantContext;
    try {
      ctx = await resolveContext();
    } catch (err) {
      // Record the denial AFTER the transaction has unwound.
      //
      // It cannot be written inline: the throw rolls the transaction back, so
      // an audit row inserted before it would vanish with everything else —
      // exactly the defect that made failed Clerk webhooks leave no trace. The
      // recorder therefore opens its own transaction.
      if (denial) await this.recordDenial(denial, claims.sub);
      throw err;
    }

    // Step 4, propagate via AsyncLocalStorage AND req object. ALS lets
    // services pull the context without prop drilling; req.tenantContext is
    // for the @CurrentTenant() decorator and direct controller access.
    (req as Request & { tenantContext?: TenantContext }).tenantContext = ctx;
    if (selectedAuthorityMembership) {
      applicationAuthorityRequests.set(req, {
        context: ctx,
        claims: { ...claims },
        membershipId: selectedAuthorityMembership.id,
        membershipTenantId: selectedAuthorityMembership.tenantId,
        requestedSlug,
        impersonationId: selectedAuthorityImpersonation,
      });
    }
    this.store.run(ctx, () => next());
  }

  /**
   * Context for Meri's approved-execution capability on `create_task`. The
   * capability is Core's own Ed25519 token (pinned key, exact header, RFC 8785
   * payload, issuer, audience, time); its signed binding names the tenant and
   * actor. Only an existing active member of an active tenant with at least
   * `standard_user` is admitted: nothing is provisioned, repaired or written.
   * The receiver re-verifies the whole capability and checks the current
   * decision, membership, client scopes, ledger and body before any effect.
   */
  private async useMeriExecutionCapability(req: Request, next: NextFunction): Promise<void> {
    const denied = () => new ForbiddenException('Application authority unavailable');
    let config: ReturnType<typeof readCoreEd25519KeyConfig>;
    try {
      config = readCoreEd25519KeyConfig(process.env, 'MERI_EXECUTION_SIGNER');
    } catch {
      config = null;
    }
    if (!config) throw new ServiceUnavailableException('Execution capabilities are not enabled');
    const token = (req.headers.authorization ?? '').slice('Bearer '.length);
    const identity = readMeriExecutionIdentity(token, config, Date.now());
    if (!identity) throw new UnauthorizedException('Invalid execution capability');
    if (req.header('x-capiro-impersonate-tenant') || req.header(TENANT_HEADER)) throw denied();
    const selected = await this.prisma.withSystem(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: identity.actorId } });
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: identity.tenantId, userId: identity.actorId, status: 'active' }, include: { tenant: true },
      });
      if (!user || !membership || membership.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, membership.role) ||
          ROLE_RANK[membership.role as TenantRole] < ROLE_RANK.standard_user) throw denied();
      return { user, membership };
    });
    const ctx: TenantContext = {
      tenantId: selected.membership.tenantId,
      tenantSlug: selected.membership.tenant.slug,
      userId: selected.user.id,
      clerkUserId: selected.user.clerkUserId,
      role: selected.membership.role as TenantRole,
    };
    (req as Request & { tenantContext?: TenantContext }).tenantContext = ctx;
    markMeriExecutionRequest(req, { token, ...identity });
    this.store.run(ctx, () => next());
  }

  /** A delegated read: the context comes from the delegation row and its
   * existing active member. Nothing is provisioned, rebound or written besides
   * the token's single-use consumption; impersonation and tenant-selection
   * headers refuse. Every current check runs in one transaction. */
  private async useMeriReadDelegation(req: Request, next: NextFunction): Promise<void> {
    const ctx = await admitMeriReadToken(req, { prisma: this.prisma, env: process.env, nowMs: Date.now() });
    (req as Request & { tenantContext?: TenantContext }).tenantContext = ctx;
    this.store.run(ctx, () => next());
  }

  /** Existing preview identity only. A missing local user/member is a denial,
   * never a repair; admitted client mutations authorize within their transaction. */
  private async usePreviewNativeRead(req: Request, next: NextFunction): Promise<void> {
    const denied = () => new ForbiddenException('Application authority unavailable');
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) throw new UnauthorizedException('Missing bearer token');
    let claims: ClerkSessionClaims;
    try {
      claims = await this.clerk.verifySessionToken(auth.slice('bearer '.length).trim());
    } catch {
      throw new UnauthorizedException('Invalid session token');
    }
    if (claims.meri_control_credential === true ||
        typeof claims.sid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sid) ||
        typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sub) ||
        !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger((claims.exp ?? 0) * 1000) ||
        (claims.exp ?? 0) * 1000 <= Date.now()) {
      throw new UnauthorizedException('Application authority unavailable');
    }
    // Check sid/sub/exp with bounded Clerk evidence BEFORE the first local DB read.
    await this.clerk.assertActiveApplicationAuthoritySession(claims);
    if (req.header('x-capiro-impersonate-tenant')) throw denied();
    const requestedSlug = this.resolveRequestedTenantSlug(req);
    const claimedTenantId = nonEmpty(claims.capiro_tenant_id);
    const claimedTenantSlug = nonEmpty(claims.capiro_tenant_slug);
    const claimedOrgId = nonEmpty(claims.org_id);
    const selected = await this.prisma.withSystem(async (tx) => {
      const user = await tx.user.findUnique({ where: { clerkUserId: claims.sub } });
      if (!user || user.clerkUserId !== claims.sub) throw denied();
      const memberships = await tx.tenantMembership.findMany({
        where: { userId: user.id, status: 'active' }, include: { tenant: true },
      });
      const chosen = memberships.find((m) => claimedTenantId && m.tenantId === claimedTenantId) ??
        memberships.find((m) => claimedOrgId && m.tenant.clerkOrgId === claimedOrgId) ??
        memberships.find((m) => claimedTenantSlug && m.tenant.slug.toLowerCase() === claimedTenantSlug.toLowerCase()) ??
        memberships.find((m) => requestedSlug && m.tenant.slug === requestedSlug) ??
        (memberships.length === 1 && !claimedTenantId && !claimedOrgId && !claimedTenantSlug && !requestedSlug
          ? memberships[0] : undefined);
      if (!chosen || chosen.status !== 'active' || chosen.tenant.status !== 'active' ||
          !Object.hasOwn(ROLE_RANK, chosen.role) ||
          (claimedTenantId && chosen.tenantId !== claimedTenantId) ||
          (claimedTenantSlug && chosen.tenant.slug.toLowerCase() !== claimedTenantSlug.toLowerCase()) ||
          (claimedOrgId && chosen.tenant.clerkOrgId !== claimedOrgId) ||
          (requestedSlug && chosen.tenant.slug !== requestedSlug)) throw denied();
      return { user, chosen };
    });
    const ctx: TenantContext = {
      tenantId: selected.chosen.tenantId,
      tenantSlug: selected.chosen.tenant.slug,
      userId: selected.user.id,
      clerkUserId: selected.user.clerkUserId,
      role: selected.chosen.role as TenantRole,
    };
    (req as Request & { tenantContext?: TenantContext }).tenantContext = ctx;
    applicationAuthorityRequests.set(req, {
      context: ctx,
      claims: { ...claims },
      membershipId: selected.chosen.id,
      membershipTenantId: selected.chosen.tenantId,
      requestedSlug,
      impersonationId: null,
    });
    this.store.run(ctx, () => next());
  }

  /** Bounded Clerk session evidence followed by fresh, read-only local checks.
   * The original authentication pipeline can provision/update/audit; this
   * method cannot repair missing authority or choose a different membership. */
  async readApplicationAuthority(req: Request, ctx: TenantContext): Promise<ApplicationAuthorityIdentityProof> {
    const session = await this.readApplicationAuthoritySession(req, ctx);
    const evidence = await session.readCurrent();
    return { ...evidence, recheckCurrent: () => session.readCurrent() };
  }

  /** Authenticate before opening a snapshot. The closure binds the private
   * request provenance and verified session; callers cannot substitute either. */
  async readApplicationAuthoritySession(req: Request, ctx: TenantContext): Promise<{
    readCurrent(transaction?: Prisma.TransactionClient): Promise<ApplicationAuthorityIdentityEvidence>;
  }> {
    const denied = () => new ForbiddenException('Application authority unavailable');
    const provenance = applicationAuthorityRequests.get(req);
    if (!provenance || provenance.context !== ctx || ctx.clerkUserId !== provenance.claims.sub) throw denied();
    const session = provenance.claims.meri_control_credential === true
      ? (isMeriControlAuthorityPost(req)
          ? await this.clerk.assertActiveMeriControlCredentialSession(provenance.claims)
          : null)
      : await this.clerk.assertActiveApplicationAuthoritySession(provenance.claims);
    if (!session) throw denied();
    return { readCurrent: (transaction) => this.readCurrentApplicationAuthority(provenance, ctx, session, transaction, true) };
  }

  /** Unmounted history-release identity leaf. The request must already carry
   * this middleware's exact native provenance; selectors never choose a user,
   * membership, tenant or a different session. Impersonation is unsupported by
   * the first history batch slice only; ordinary authentication is unchanged. */
  private historyReleaseProvenance(req: Request, ctx: TenantContext): ApplicationAuthorityRequestProvenance {
    const provenance = applicationAuthorityRequests.get(req);
    const path = mountedRequestPath(req);
    const target = req.originalUrl ?? req.url ?? '';
    const authorization = req.headers.authorization;
    if (!provenance || provenance.context !== ctx || ctx.clerkUserId !== provenance.claims.sub ||
        provenance.claims.meri_control_credential === true || provenance.impersonationId !== null ||
        provenance.membershipTenantId !== ctx.tenantId ||
        req.header('x-capiro-impersonate-tenant') !== undefined || req.method !== 'POST' ||
        typeof path !== 'string' || target !== path ||
        (path.startsWith('/api/') ? path.slice(4) : path) !== '/clio/application-authority/history-release' ||
        typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization) ||
        typeof provenance.claims.sid !== 'string' || provenance.claims.sid.length === 0) {
      throw new ForbiddenException('Application authority unavailable');
    }
    return provenance;
  }

  /** Caller owns the one REPEATABLE READ transaction. These locks remain held
   * through the batch owner's final session check and transaction commit.
   * Bare SQL does not inherit Prisma's tenant predicate: pin every local fact. */
  async lockOriginalApplicationAuthorityInTransaction(
    req: Request, ctx: TenantContext, tx: Prisma.TransactionClient,
  ): Promise<void> {
    const provenance = this.historyReleaseProvenance(req, ctx);
    const denied = () => new ForbiddenException('Application authority unavailable');
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS "id" FROM users
       WHERE id = ${ctx.userId}::uuid AND clerk_user_id = ${provenance.claims.sub}
       FOR SHARE
    `;
    if (users.length !== 1 || users[0]?.id !== ctx.userId) throw denied();
    const tenants = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS "id" FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR SHARE
    `;
    if (tenants.length !== 1 || tenants[0]?.id !== ctx.tenantId) throw denied();
    const memberships = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS "id" FROM tenant_memberships
       WHERE id = ${provenance.membershipId}::uuid
         AND tenant_id = ${provenance.membershipTenantId}::uuid
         AND user_id = ${ctx.userId}::uuid
       FOR SHARE
    `;
    if (memberships.length !== 1 || memberships[0]?.id !== provenance.membershipId) throw denied();
  }

  /** Check the same session under the caller's held local locks. Clerk may
   * reuse positive evidence for at most five seconds; local identity is always
   * re-read on that same transaction, with no nested withSystem lease. */
  async readFreshApplicationAuthorityInTransaction(
    req: Request, ctx: TenantContext, tx: Prisma.TransactionClient,
  ): Promise<ApplicationAuthorityIdentityEvidence> {
    const provenance = this.historyReleaseProvenance(req, ctx);
    const session = await this.clerk.assertActiveApplicationAuthoritySession(provenance.claims);
    return this.readCurrentApplicationAuthority(provenance, ctx, session, tx);
  }

  /** Core-only capture from an actual natively authenticated request/context pair. */
  async captureRetainedNativeAuthority(req: Request, ctx: TenantContext): Promise<RetainedNativeAuthorityCapture> {
    const provenance = applicationAuthorityRequests.get(req);
    if (!provenance || provenance.context !== ctx || ctx.clerkUserId !== provenance.claims.sub) {
      throw new ForbiddenException('Application authority unavailable');
    }
    const evidence = await this.readApplicationAuthority(req, ctx);
    return captureRetainedNativeAuthority(provenance, evidence);
  }

  /** Only the receiving signed-codec closure can supply this runtime proof.
   * Every invocation checks bounded Clerk evidence and freshly reads local facts. */
  async requiresVerifiedRetainedNativeAuthority(verified: VerifiedRetainedNativeAuthority): Promise<RetainedNativeAuthorityCurrent> {
    return requiresVerifiedRetainedNativeAuthority(verified, async (provenance) => {
      if (Date.now() >= verified.originalExpiresAtMs) throw new UnauthorizedException('Application authority unavailable');
      this.clerk.assertRetainedApplicationAuthorityIssuer(provenance.claims.iss);
      const session = await this.clerk.assertActiveApplicationAuthoritySession(provenance.claims);
      if (Date.now() >= verified.originalExpiresAtMs) throw new UnauthorizedException('Application authority unavailable');
      return this.readCurrentApplicationAuthority(provenance, provenance.context, session);
    });
  }

  private async readCurrentApplicationAuthority(
    provenance: ApplicationAuthorityRequestProvenance,
    ctx: TenantContext,
    session: ActiveApplicationAuthoritySession,
    transaction?: Prisma.TransactionClient,
    preserveTransactionUnavailable = false,
  ): Promise<ApplicationAuthorityIdentityEvidence> {
    const denied = () => new ForbiddenException('Application authority unavailable');
    if (provenance.context !== ctx || ctx.clerkUserId !== provenance.claims.sub) throw denied();
    try {
      const read = async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.findFirst({
          where: { id: ctx.userId, clerkUserId: provenance.claims.sub }, select: { id: true, clerkUserId: true },
        });
        const membership = await tx.tenantMembership.findFirst({
          where: { id: provenance.membershipId, tenantId: provenance.membershipTenantId, userId: ctx.userId, status: 'active' },
          include: { tenant: true },
        });
        if (!user || user.id !== ctx.userId || user.clerkUserId !== provenance.claims.sub ||
            !membership || membership.id !== provenance.membershipId || membership.userId !== ctx.userId ||
            membership.tenantId !== provenance.membershipTenantId || membership.status !== 'active' ||
            membership.role !== ctx.role || membership.tenant.id !== membership.tenantId ||
            membership.tenant.status !== 'active') throw denied();
        const claims = provenance.claims;
        if ((nonEmpty(claims.capiro_tenant_id) && membership.tenantId !== nonEmpty(claims.capiro_tenant_id)) ||
            (nonEmpty(claims.org_id) && membership.tenant.clerkOrgId !== nonEmpty(claims.org_id)) ||
            (nonEmpty(claims.capiro_tenant_slug) && membership.tenant.slug.toLowerCase() !== nonEmpty(claims.capiro_tenant_slug)?.toLowerCase()) ||
            (provenance.requestedSlug && membership.tenant.slug !== provenance.requestedSlug)) throw denied();
        let impersonationFacts: unknown = null;
        let expiresAtMs = session.expiresAtMs;
        if (provenance.impersonationId !== null) {
          if (membership.role !== 'capiro_admin') throw denied();
          const impersonation = await tx.impersonationSession.findFirst({
            where: { id: provenance.impersonationId, actorUserId: ctx.userId, tenantId: ctx.tenantId, endedAt: null, expiresAt: { gt: new Date() } },
            include: { tenant: true },
          });
          if (!impersonation || impersonation.id !== provenance.impersonationId ||
              impersonation.actorUserId !== ctx.userId || impersonation.tenantId !== ctx.tenantId ||
              impersonation.endedAt !== null || impersonation.tenant.id !== ctx.tenantId ||
              impersonation.tenant.status !== 'active' || impersonation.tenant.slug !== ctx.tenantSlug) throw denied();
          expiresAtMs = Math.min(expiresAtMs, impersonation.expiresAt.getTime());
          impersonationFacts = [impersonation.id, impersonation.actorUserId, impersonation.tenantId,
            impersonation.startedAt.getTime(), impersonation.expiresAt.getTime(), impersonation.endedAt,
            impersonation.tenant.status, impersonation.tenant.clerkOrgId];
        } else if (ctx.tenantId !== membership.tenantId || ctx.tenantSlug !== membership.tenant.slug) throw denied();
        if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) throw denied();
        return {
          principal: { tenantId: ctx.tenantId, actorId: user.id },
          identityRevision: applicationAuthorityRevision('identity', [
            [session.id, session.userId, session.status, session.createdAt, session.expireAt, session.abandonAt, session.actor],
            [user.id, user.clerkUserId],
            [membership.id, membership.tenantId, membership.userId, membership.role, membership.status, membership.updatedAt.getTime()],
            [membership.tenant.id, membership.tenant.status, membership.tenant.clerkOrgId],
            impersonationFacts,
          ]),
          expiresAtMs,
        };
      };
      return transaction ? await read(transaction) : await this.prisma.withSystem(read);
    } catch (error) {
      // The combined receipt owns its outage response. Other callers retain
      // their existing refusal mapping, including held-lock release owners.
      if (transaction && preserveTransactionUnavailable &&
          (!(error instanceof HttpException) || error instanceof ServiceUnavailableException)) throw error;
      throw denied();
    }
  }

  /**
   * Emit the SOC 2 evidence for a rejected request: a structured `auth.denied`
   * line (counted by the Capiro/Security metric filter) and, when a tenant was
   * actually resolved, an append-only audit_logs row its own admins can see.
   *
   * audit_logs.tenant_id is NOT NULL, so the two pre-resolution reasons
   * (no_active_membership, no_matching_tenant) get the log line only — there is
   * no tenant to attribute them to yet.
   *
   * The claimed-vs-resolved pair is encoded in `action` + `entityId` rather than
   * before/after, because the customer-facing audit projection redacts those.
   *
   * Entirely best-effort: this is telemetry on a path that is ALREADY failing,
   * and it must never convert a clean 403 into a 500.
   */
  private async recordDenial(
    denial: { reason: AuthDeniedReason; tenantId?: string | null; claimedTenantId?: string | null },
    clerkUserId: string,
  ): Promise<void> {
    this.logger.warn(
      authDeniedEvent({
        reason: denial.reason,
        surface: 'http',
        tenantId: denial.tenantId,
        claimedTenantId: denial.claimedTenantId,
        clerkUserId,
      }),
    );

    if (!denial.tenantId) return;

    try {
      await this.prisma.withSystem((tx) =>
        tx.auditLog.create({
          data: {
            tenantId: denial.tenantId as string,
            actorUserId: null,
            actorRole: null,
            action: `auth.denied.${denial.reason}`,
            entityType: 'tenant',
            // The CLAIMED id, never the resolved one — that is the fact under
            // review.
            entityId: denial.claimedTenantId ?? null,
          },
        }),
      );
    } catch (auditErr) {
      this.logger.error(`auth-denial audit write failed: ${(auditErr as Error).message}`);
    }
  }

  /**
   * Provision a local tenant_membership from a verified Clerk JWT when the
   * webhook-populated mirror is missing it. Returns the membership (with its
   * tenant) to use, or null if it cannot / must not be provisioned.
   *
   * Safety rules (this is an authorization path — fail closed):
   *   - The tenant is resolved by `clerk_org_id === org_id`, and org_id is a
   *     verified JWT claim, so we only ever provision a tenant the JWT already
   *     proves the user is a Clerk member of.
   *   - If the JWT also carries capiro_tenant_id / capiro_tenant_slug, they
   *     MUST agree with the resolved tenant (the same integrity checks the
   *     caller applies post-resolution), otherwise we bail.
   *   - The tenant must be active.
   *   - A pre-existing non-active membership (removed/suspended) is NOT
   *     resurrected: offboarding stays sticky and must be redone via the normal
   *     invite flow.
   */
  private async selfHealMembership(
    tx: SystemTx,
    userId: string,
    hints: {
      claimedOrgId: string;
      claimedTenantId?: string;
      claimedTenantSlug?: string;
      orgRole?: string;
    },
  ): Promise<MembershipWithTenant | null> {
    const tenant = await tx.tenant.findUnique({ where: { clerkOrgId: hints.claimedOrgId } });
    if (!tenant || tenant.status !== 'active') {
      return null;
    }
    if (hints.claimedTenantId && tenant.id !== hints.claimedTenantId) {
      return null;
    }
    if (
      hints.claimedTenantSlug &&
      tenant.slug.toLowerCase() !== hints.claimedTenantSlug.toLowerCase()
    ) {
      return null;
    }

    const existing = await tx.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: tenant.id, userId } },
      include: { tenant: true },
    });
    if (existing) {
      // A row exists but was not in the active set (removed/suspended). Do not
      // silently re-grant access; require an explicit re-invite.
      return existing.status === 'active' ? existing : null;
    }

    // Mirror the webhook's role derivation exactly, keyed on the DB tenant slug
    // (authoritative) rather than the JWT's org_slug claim.
    const role = mapClerkRoleToCapiro(tenant.slug, hints.orgRole ?? 'org:member');
    return tx.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId,
        role,
        status: 'active',
        joinedAt: new Date(),
      },
      include: { tenant: true },
    });
  }

  private resolveRequestedTenantSlug(req: Request): string | undefined {
    const headerVal = req.header(TENANT_HEADER);
    if (headerVal) return headerVal.trim().toLowerCase();

    const host = req.hostname; // e.g. acmelobby.app.capiro.ai
    const parts = host.split('.');
    // {slug}.app.capiro.ai, only treat as a tenant slug when the shape AND
    // TLD match. Strict matching prevents a malicious host header from
    // injecting an arbitrary slug via a lookalike domain.
    if (parts.length === 4 && parts[1] === 'app' && parts[2] === 'capiro' && parts[3] === 'ai') {
      return parts[0]?.toLowerCase();
    }
    return undefined;
  }
}

// Clerk's JWT template emits empty strings for `{{org.*}}` placeholders when
// the user has no active org. We treat empty as "no signal" rather than
// matching a tenant whose slug is literally "".
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isBypassPath(
  bypassPath: string,
  path: string,
  originalUrl: string,
  baseUrl: string,
): boolean {
  return (
    path === bypassPath ||
    originalUrl === bypassPath ||
    path.startsWith(`${bypassPath}/`) ||
    originalUrl.startsWith(`${bypassPath}/`) ||
    originalUrl.startsWith(`${bypassPath}?`) ||
    `${baseUrl}${path}` === bypassPath
  );
}
