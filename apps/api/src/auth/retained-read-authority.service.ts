import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { readResearchPortfolioResourceRevision } from '../research-portfolios/research-portfolio-current-authority.js';
import {
  applicationAuthorityIdentityReceipt,
  type ApplicationAuthorityIdentityEvidence,
  type ApplicationAuthorityIdentityProof,
} from './application-authority.js';
import type { ApplicationMembershipControl } from './application-membership.js';
import type {
  RetainedNativeAuthorityCapture,
  VerifiedRetainedNativeAuthority,
} from './retained-native-authority.js';
import {
  parseRetainedFloridaFacts,
  parseRetainedFloridaSelector,
  parseRetainedPortfolioSelector,
  retainedSelectorSha256,
  RETAINED_FLORIDA_AUTHORITY,
  RETAINED_READ_SOURCE_ENABLED,
  RETAINED_SHA256,
  RETAINED_UUID,
  type RetainedFloridaAuthorityFacts,
  type RetainedFloridaSelector,
  type RetainedReadOperation,
  type RetainedReadReceiptBase,
} from './retained-read-authority.js';

/** Control-side source connection only. An actor plus service secret is not this port. */
export interface RetainedFloridaAuthorityPort {
  read(input: {
    principal: { tenantId: string; actorId: string; clerkUserId: string };
    selector: Readonly<RetainedFloridaSelector>;
    nativeAuthority: RetainedNativeAuthorityCapture;
    control: ApplicationMembershipControl;
  }): Promise<RetainedFloridaAuthorityFacts>;
}

const unavailable = () =>
  new ServiceUnavailableException('Retained authority unavailable');
const changed = () =>
  new ConflictException('Retained authority changed; reload');
const denied = () => new ForbiddenException('Retained authority unavailable');

@Injectable()
export class RetainedReadAuthorityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextMiddleware,
    @Inject(RETAINED_READ_SOURCE_ENABLED) private readonly enabled: boolean,
    @Inject(RETAINED_FLORIDA_AUTHORITY)
    private readonly florida: RetainedFloridaAuthorityPort,
  ) {}

  async portfolio(
    req: Request,
    ctx: TenantContext,
    operation: 'get_research_portfolio' | 'get_research_portfolio_changes',
    body: unknown,
    control: ApplicationMembershipControl,
  ) {
    const selector = Object.freeze(parseRetainedPortfolioSelector(body));
    const result = await this.observe(
      ctx,
      operation,
      control,
      async () =>
        this.prisma.withTenant(
          ctx.tenantId,
          (tx) =>
            readResearchPortfolioResourceRevision(
              tx,
              ctx,
              selector.portfolioId,
              operation,
              () => control.assertActive(),
            ),
          { timeoutMs: this.transactionTimeout(control) },
        ),
      () => this.tenant.readApplicationAuthority(req, ctx),
    );
    return {
      ...result.receipt,
      selectorSha256: retainedSelectorSha256(selector),
      scope: { portfolioId: result.facts.portfolioId },
    };
  }

  async floridaBudget(
    req: Request,
    ctx: TenantContext,
    body: unknown,
    control: ApplicationMembershipControl,
  ) {
    const selector = Object.freeze(parseRetainedFloridaSelector(body));
    const result = await this.observe(
      ctx,
      'get_florida_budget_project',
      control,
      async () => {
        if (!this.florida) throw unavailable();
        const nativeAuthority =
          await this.tenant.captureRetainedNativeAuthority(req, ctx);
        control.assertActive();
        const facts = await this.florida.read({
          principal: {
            tenantId: ctx.tenantId,
            actorId: ctx.userId,
            clerkUserId: ctx.clerkUserId,
          },
          selector,
          nativeAuthority,
          control,
        });
        control.assertActive();
        return parseRetainedFloridaFacts(facts, selector);
      },
      () => this.tenant.readApplicationAuthority(req, ctx),
    );
    return {
      ...result.receipt,
      selectorSha256: retainedSelectorSha256(selector),
      effectiveScope: { ...result.facts.effectiveScope },
      clientResolution:
        result.facts.clientResolution === null
          ? null
          : { ...result.facts.clientResolution },
    };
  }

  /** Internal source path: only the receiving codec's private runtime brand is admitted. */
  async currentVerified(
    verified: VerifiedRetainedNativeAuthority,
    operation: RetainedReadOperation,
    body: unknown,
    control: ApplicationMembershipControl,
  ) {
    control.assertActive();
    if (this.enabled !== true) throw unavailable();
    const initial =
      await this.tenant.requiresVerifiedRetainedNativeAuthority(verified);
    control.assertActive();
    const ctx = initial.context;
    const readIdentity =
      async (): Promise<ApplicationAuthorityIdentityProof> => {
        control.assertActive();
        const current =
          await this.tenant.requiresVerifiedRetainedNativeAuthority(verified);
        control.assertActive();
        return {
          ...current.identity,
          recheckCurrent: async () => {
            control.assertActive();
            const latest =
              await this.tenant.requiresVerifiedRetainedNativeAuthority(
                verified,
              );
            control.assertActive();
            return latest.identity;
          },
        };
      };
    if (operation === 'get_florida_budget_project') {
      const selector = Object.freeze(parseRetainedFloridaSelector(body));
      const result = await this.observe(
        ctx,
        operation,
        control,
        async () => {
          const facts = await this.florida.read({
            principal: verified.principal,
            selector,
            nativeAuthority: verified,
            control,
          });
          control.assertActive();
          return parseRetainedFloridaFacts(facts, selector);
        },
        readIdentity,
      );
      return {
        ...result.receipt,
        selectorSha256: retainedSelectorSha256(selector),
        effectiveScope: result.facts.effectiveScope,
        clientResolution: result.facts.clientResolution,
      };
    }
    const selector = Object.freeze(parseRetainedPortfolioSelector(body));
    const result = await this.observe(
      ctx,
      operation,
      control,
      async () =>
        this.prisma.withTenant(
          ctx.tenantId,
          (tx) =>
            readResearchPortfolioResourceRevision(
              tx,
              ctx,
              selector.portfolioId,
              operation,
              () => control.assertActive(),
            ),
          { timeoutMs: this.transactionTimeout(control) },
        ),
      readIdentity,
    );
    return {
      ...result.receipt,
      selectorSha256: retainedSelectorSha256(selector),
      scope: { portfolioId: selector.portfolioId },
    };
  }

  private async observe<T extends { resourceRevision: string }>(
    ctx: TenantContext,
    operation: RetainedReadOperation,
    control: ApplicationMembershipControl,
    read: () => Promise<T>,
    readIdentity: () => Promise<ApplicationAuthorityIdentityProof>,
  ): Promise<{
    receipt: Omit<RetainedReadReceiptBase, 'selectorSha256'>;
    facts: T;
  }> {
    control.assertActive();
    if (this.enabled !== true) throw unavailable();
    if (
      !RETAINED_UUID.test(ctx.tenantId) ||
      !RETAINED_UUID.test(ctx.userId) ||
      !ctx.clerkUserId
    )
      throw denied();
    const firstIdentity = await readIdentity();
    control.assertActive();
    this.assertIdentity(firstIdentity, ctx);
    const firstMember = await this.selectedMembership(ctx, control);
    control.assertActive();
    const first = await this.source(control, read);
    control.assertActive();
    this.assertRevision(first.resourceRevision);
    const current = await readIdentity();
    control.assertActive();
    this.assertIdentity(current, ctx);
    if (firstIdentity.identityRevision !== current.identityRevision)
      throw changed();
    const secondMember = await this.selectedMembership(ctx, control);
    control.assertActive();
    const second = await this.source(control, read);
    control.assertActive();
    this.assertRevision(second.resourceRevision);
    if (
      firstMember !== secondMember ||
      JSON.stringify(first) !== JSON.stringify(second)
    )
      throw changed();
    const finalIdentity = await current.recheckCurrent();
    control.assertActive();
    this.assertIdentity(finalIdentity, ctx);
    if (current.identityRevision !== finalIdentity.identityRevision)
      throw changed();
    const lastMember = await this.selectedMembership(ctx, control);
    control.assertActive();
    const latest = await this.source(control, read);
    control.assertActive();
    this.assertRevision(latest.resourceRevision);
    if (
      secondMember !== lastMember ||
      JSON.stringify(second) !== JSON.stringify(latest)
    )
      throw changed();
    const identity = applicationAuthorityIdentityReceipt({
      ...finalIdentity,
      expiresAtMs: Math.min(
        firstIdentity.expiresAtMs,
        current.expiresAtMs,
        finalIdentity.expiresAtMs,
        control.deadlineMs,
      ),
    });
    return {
      facts: latest,
      receipt: {
        schemaVersion: 1,
        operation,
        principal: { ...identity.principal },
        identityRevision: identity.identityRevision,
        resourceRevision: latest.resourceRevision,
        checkedAtMs: identity.checkedAtMs,
        expiresAtMs: identity.expiresAtMs,
      },
    };
  }

  private assertIdentity(
    identity: ApplicationAuthorityIdentityEvidence,
    ctx: TenantContext,
  ) {
    applicationAuthorityIdentityReceipt(identity);
    if (
      identity.principal.tenantId !== ctx.tenantId ||
      identity.principal.actorId !== ctx.userId
    )
      throw denied();
  }

  private assertRevision(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !RETAINED_SHA256.test(value))
      throw unavailable();
  }

  private transactionTimeout(control: ApplicationMembershipControl) {
    control.assertActive();
    return Math.max(1, Math.min(5000, control.deadlineMs - Date.now()));
  }

  private async selectedMembership(
    ctx: TenantContext,
    control: ApplicationMembershipControl,
  ): Promise<string> {
    const row = await this.source(control, () =>
      this.prisma.withTenant(
        ctx.tenantId,
        (tx) => {
          control.assertActive();
          return tx.tenantMembership.findFirst({
            where: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              status: 'active',
            },
            select: {
              id: true,
              tenantId: true,
              userId: true,
              status: true,
              role: true,
              updatedAt: true,
              tenant: { select: { id: true, status: true } },
            },
          });
        },
        { timeoutMs: this.transactionTimeout(control) },
      ),
    );
    control.assertActive();
    if (
      !row ||
      row.tenantId !== ctx.tenantId ||
      row.userId !== ctx.userId ||
      row.status !== 'active' ||
      row.tenant.id !== ctx.tenantId ||
      row.tenant.status !== 'active' ||
      !Object.hasOwn(ROLE_RANK, row.role) ||
      ROLE_RANK[row.role as TenantRole] < ROLE_RANK.standard_user
    )
      throw denied();
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 256 ||
      !(row.updatedAt instanceof Date) ||
      !Number.isSafeInteger(row.updatedAt.getTime()) ||
      row.updatedAt.getTime() < 0
    )
      throw unavailable();
    return JSON.stringify([row.id, row.role, row.updatedAt.getTime()]);
  }

  private async source<T>(
    control: ApplicationMembershipControl,
    read: () => Promise<T>,
  ): Promise<T> {
    control.assertActive();
    try {
      const result = await read();
      control.assertActive();
      return result;
    } catch (error) {
      control.assertActive();
      if (error instanceof HttpException) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number' &&
        [400, 401, 403, 404, 408, 409, 503].includes(error.status)
      ) {
        throw new HttpException(
          'Retained authority source unavailable',
          error.status,
        );
      }
      throw unavailable();
    }
  }
}
