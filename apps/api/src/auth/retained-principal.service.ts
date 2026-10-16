import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type {
  CoreRetainedPrincipalCanonicalizer,
  CoreRetainedPrincipalCryptographicVerifier,
  CoreRetainedPrincipalEnvelope,
  CoreRetainedPrincipalSigner,
  CoreRetainedReadOperation,
} from '@capiro/shared/core-retained-principal';
import type { Request } from 'express';
import { ResearchPortfoliosService } from '../research-portfolios/research-portfolios.service.js';
import { ResearchPortfolioChangesService } from '../research-portfolios/research-portfolio-changes.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import type { ApplicationMembershipControl } from './application-membership.js';
import { createRetainedNativeAuthorityReceiver } from './retained-native-authority.js';
import { RetainedReadAuthorityService } from './retained-read-authority.service.js';
import { parseRetainedReadBody } from './retained-read-request.js';

export const RETAINED_PRINCIPAL_PORTS = Symbol('retained-principal-ports');
/** Source configuration only: no process environment, key discovery or fallback. */
export interface RetainedPrincipalPorts {
  canonicalize: CoreRetainedPrincipalCanonicalizer;
  signers: Readonly<
    Record<CoreRetainedReadOperation, CoreRetainedPrincipalSigner>
  >;
  verifiers: Readonly<
    Record<
      CoreRetainedReadOperation,
      CoreRetainedPrincipalCryptographicVerifier
    >
  >;
}
const unavailable = () =>
  new ServiceUnavailableException('Retained principal unavailable');
const changed = () =>
  new ConflictException('Retained authority changed; reload');
const denied = () => new ForbiddenException('Retained principal unavailable');
const DATA_PATHS = Object.freeze({
  get_research_portfolio: '/api/clio/retained-reads/research-portfolio',
  get_research_portfolio_changes:
    '/api/clio/retained-reads/research-portfolio-changes',
  get_florida_budget_project:
    '/intel-api/internal/legiwatch/retained-florida-budget',
});
type Parsed = ReturnType<typeof parseRetainedReadBody>;

/** Bounded Core owner; Meri task/run/fence admission remains CONTROL-owned. */
@Injectable()
export class RetainedPrincipalService {
  constructor(
    private readonly tenant: TenantContextMiddleware,
    private readonly authority: RetainedReadAuthorityService,
    private readonly portfolios: ResearchPortfoliosService,
    private readonly changes: ResearchPortfolioChangesService,
    @Inject(RETAINED_PRINCIPAL_PORTS)
    private readonly ports: RetainedPrincipalPorts | null,
  ) {}

  async issue(
    req: Request,
    ctx: TenantContext,
    operation: CoreRetainedReadOperation,
    body: unknown,
    control: ApplicationMembershipControl,
  ): Promise<CoreRetainedPrincipalEnvelope> {
    control.assertActive();
    const ports = this.configured(operation);
    const parsed = parseRetainedReadBody(
      operation,
      body,
      { issuer: true },
      ports.canonicalize,
    );
    control = this.bounded(control, parsed.originalExpiresAtMs!);
    control.assertActive();
    const original = await this.tenant.captureRetainedNativeAuthority(req, ctx);
    control.assertActive();
    control = this.bounded(control, original.originalExpiresAtMs);
    this.correlatePrincipal(parsed, original.principal);
    const facts =
      operation === 'get_florida_budget_project'
        ? await this.authority.floridaBudget(req, ctx, parsed.selector, control)
        : await this.authority.portfolio(
            req,
            ctx,
            operation,
            parsed.selector,
            control,
          );
    control.assertActive();
    const latest = await this.tenant.captureRetainedNativeAuthority(req, ctx);
    control.assertActive();
    if (
      original.identityRevision !== latest.identityRevision ||
      facts.identityRevision !== latest.identityRevision ||
      ports.canonicalize(original.principal) !==
        ports.canonicalize(latest.principal)
    )
      throw changed();
    this.correlateResource(parsed, facts);
    const nowMs = Date.now();
    const originalExpiresAtMs = Math.min(
      parsed.originalExpiresAtMs!,
      original.originalExpiresAtMs,
      latest.originalExpiresAtMs,
      facts.expiresAtMs,
      control.deadlineMs,
      nowMs + 30_000,
    );
    if (
      !Number.isSafeInteger(originalExpiresAtMs) ||
      originalExpiresAtMs <= nowMs
    )
      throw new UnauthorizedException('Retained principal expired');
    const signed = this.codec(() =>
      ports.signers[operation].sign(
        {
          principal: latest.principal,
          identityRevision: latest.identityRevision,
          resourceRevision: facts.resourceRevision,
          ...parsed.digests,
          currentAuthority: latest.currentAuthority,
          issuedAtMs: nowMs,
          originalExpiresAtMs,
        },
        { nowMs, deadlineMs: control.deadlineMs },
      ),
    );
    // The issuer returns the closed raw envelope, never a header wrapper or bearer.
    const envelope = this.codec(() =>
      ports.verifiers[operation].verifyCryptographically(signed, {
        nowMs: Date.now(),
        deadlineMs: control.deadlineMs,
        expectedDigests: parsed.digests,
      }),
    );
    this.correlateRecipient(envelope, operation);
    control.assertActive();
    return envelope;
  }

  /** Fresh native AND resource verification, used before effects and release. */
  async verifyCurrent(
    authorization: unknown,
    operation: CoreRetainedReadOperation,
    body: unknown,
    control: ApplicationMembershipControl,
  ) {
    control.assertActive();
    const ports = this.configured(operation);
    const parsed = parseRetainedReadBody(
      operation,
      body,
      { issuer: false },
      ports.canonicalize,
    );
    const bounds = {
      nowMs: Date.now(),
      deadlineMs: control.deadlineMs,
      expectedDigests: parsed.digests,
    };
    const codec = ports.verifiers[operation];
    const envelope = this.codec(() =>
      codec.verifyCryptographically(authorization, bounds),
    );
    this.correlateRecipient(envelope, operation);
    control = this.bounded(control, envelope.originalExpiresAtMs);
    const verified = this.codec(() =>
      createRetainedNativeAuthorityReceiver(codec).verifyCryptographically(
        authorization,
        bounds,
      ),
    );
    control.assertActive();
    const native =
      await this.tenant.requiresVerifiedRetainedNativeAuthority(verified);
    control.assertActive();
    this.correlatePrincipal(parsed, verified.principal);
    const resource = await this.authority.currentVerified(
      verified,
      operation,
      parsed.selector,
      control,
    );
    control.assertActive();
    if (
      resource.identityRevision !== envelope.identityRevision ||
      resource.resourceRevision !== envelope.resourceRevision
    )
      throw changed();
    this.correlateResource(parsed, resource);
    return {
      parsed,
      context: native.context,
      receipt: Object.freeze({
        principal: envelope.principal,
        identityRevision: envelope.identityRevision,
        resourceRevision: envelope.resourceRevision,
        checkedAtMs: resource.checkedAtMs,
        originalExpiresAtMs: Math.min(
          envelope.originalExpiresAtMs,
          resource.expiresAtMs,
        ),
      }),
    };
  }

  async readPortfolio(
    authorization: unknown,
    operation: 'get_research_portfolio' | 'get_research_portfolio_changes',
    body: unknown,
    control: ApplicationMembershipControl,
  ) {
    const first = await this.verifyCurrent(
      authorization,
      operation,
      body,
      control,
    );
    control = this.bounded(control, first.receipt.originalExpiresAtMs);
    control.assertActive();
    const args = first.parsed.normalizedArgs as {
      portfolioId: string;
      cursor?: string | null;
      limit?: number;
    };
    // Reuse the actual canonical business DTO/filtering owners, never agent loops.
    const result =
      operation === 'get_research_portfolio'
        ? await this.portfolios.detail(first.context, args.portfolioId)
        : await this.changes.listChanges(
            first.context,
            args.portfolioId,
            args.cursor ?? null,
            args.limit ?? 25,
          );
    control.assertActive();
    const last = await this.verifyCurrent(
      authorization,
      operation,
      {
        schemaVersion: 1,
        request: first.parsed.request,
        context: first.parsed.context,
      },
      control,
    );
    control.assertActive();
    if (
      first.receipt.identityRevision !== last.receipt.identityRevision ||
      first.receipt.resourceRevision !== last.receipt.resourceRevision
    )
      throw changed();
    return result;
  }

  private configured(
    operation?: CoreRetainedReadOperation,
  ): RetainedPrincipalPorts {
    if (
      !this.ports ||
      typeof this.ports.canonicalize !== 'function' ||
      !this.ports.signers ||
      !this.ports.verifiers
    )
      throw unavailable();
    if (
      operation &&
      (typeof this.ports.signers[operation]?.sign !== 'function' ||
        typeof this.ports.verifiers[operation]?.verifyCryptographically !==
          'function')
    )
      throw unavailable();
    return this.ports;
  }

  private bounded(
    caller: ApplicationMembershipControl,
    cutoff: number,
  ): ApplicationMembershipControl {
    const deadlineMs = Math.min(caller.deadlineMs, cutoff);
    const control = {
      deadlineMs,
      assertActive() {
        caller.assertActive();
        if (!Number.isSafeInteger(deadlineMs) || Date.now() >= deadlineMs)
          throw new RequestTimeoutException(
            'Retained request no longer active',
          );
      },
    };
    control.assertActive();
    return control;
  }

  private correlatePrincipal(
    parsed: Parsed,
    principal: { tenantId: string; actorId: string },
  ) {
    if ('binding' in parsed.context) {
      const context = parsed.context as {
        binding: { tenantId: string; actorId: string };
        subject: { tenantId: string; actorId: string };
      };
      if (
        context.binding.tenantId !== principal.tenantId ||
        context.binding.actorId !== principal.actorId ||
        context.subject.tenantId !== principal.tenantId ||
        context.subject.actorId !== principal.actorId
      )
        throw denied();
    }
  }

  private correlateRecipient(
    envelope: CoreRetainedPrincipalEnvelope,
    operation: CoreRetainedReadOperation,
  ) {
    if (
      envelope.operation !== operation ||
      envelope.recipientPath !== DATA_PATHS[operation]
    ) {
      throw new UnauthorizedException('Invalid retained principal recipient');
    }
  }

  private correlateResource(parsed: Parsed, receipt: unknown) {
    const current = receipt as {
      scope?: { portfolioId: string };
      effectiveScope?: unknown;
      clientResolution?: unknown;
    };
    const ports = this.configured();
    if ('portfolioId' in parsed.selector) {
      if (current.scope?.portfolioId !== parsed.selector.portfolioId)
        throw changed();
    } else {
      const context = parsed.context as {
        effectiveScope: unknown;
        clientResolution: unknown;
      };
      if (
        ports.canonicalize(current.effectiveScope) !==
          ports.canonicalize(context.effectiveScope) ||
        ports.canonicalize(current.clientResolution) !==
          ports.canonicalize(context.clientResolution)
      )
        throw changed();
    }
  }

  private codec<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 401
      )
        throw new UnauthorizedException('Invalid retained principal');
      throw unavailable();
    }
  }
}
