import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

/** Signed state carried through the Microsoft admin-consent round-trip. */
interface ConsentState {
  inviteId: string;
  exp: number;
  nonce: string;
}

export interface ItInviteView {
  orgName: string;
  email: string;
  status: string;
  provider: string | null;
}

/**
 * IT-admin authorization path (Gherkin "IT Admin"): the invited email-provider
 * admin has NO Capiro account — the emailed link carries a single-purpose
 * token (stored hashed) that opens the one-task connect page.
 *
 * Microsoft (the only v1 provider — Google is deferred, decision Q5): the
 * "Connect with Microsoft" button sends the admin to Entra's tenant-wide
 * admin-consent endpoint for the existing multi-tenant Capiro app
 * (MICROSOFT_CLIENT_ID, the same app users connect mailboxes to). On the
 * signed-state callback with admin_consent=True we record the customer's
 * Entra tenant id, mark the invite granted, and flip the it_email setup task
 * to done — unlocking nothing else (Gherkin: only "Send team invites" gates
 * on it). Full "verified" status upgrades when the first user mailbox
 * connect succeeds (engagement-side signal, follow-up).
 */
@Injectable()
export class ItAdminService {
  private readonly logger = new Logger(ItAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get stateSecret(): string {
    const secret = this.config.get<string>('OAUTH_STATE_SECRET');
    if (!secret) throw new BadRequestException('OAUTH_STATE_SECRET is not configured');
    return secret;
  }

  private get publicApiBase(): string {
    return (
      this.config.get<string>('ONBOARD_API_PUBLIC_BASE_URL') ?? 'https://app.capiro.ai'
    ).replace(/\/$/, '');
  }

  private get publicWebBase(): string {
    return (
      this.config.get<string>('ONBOARD_PUBLIC_BASE_URL') ?? 'https://onboarding.capiro.ai'
    ).replace(/\/$/, '');
  }

  private async findByToken(rawToken: string) {
    if (!/^[0-9a-f]{64}$/.test(rawToken)) throw new ForbiddenException('Invalid invite link');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const invite = await this.prisma.onboardItInvite.findUnique({ where: { tokenHash } });
    if (!invite || invite.status === 'revoked') {
      throw new NotFoundException('Invite expired, contact your administrator');
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException('Invite expired, contact your administrator');
    }
    return invite;
  }

  async getInvite(rawToken: string): Promise<ItInviteView> {
    const invite = await this.findByToken(rawToken);
    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({ where: { id: invite.tenantId }, select: { name: true } }),
    );
    return {
      orgName: tenant?.name ?? 'your firm',
      email: invite.email,
      status: invite.status,
      provider: invite.provider,
    };
  }

  /** Build the Entra tenant-wide admin-consent URL for this invite. */
  async buildConsentUrl(rawToken: string, provider: string): Promise<{ url: string }> {
    if (provider !== 'microsoft') {
      // Google is deferred (decision Q5): the button renders disabled.
      throw new BadRequestException('Only Microsoft is available right now');
    }
    const invite = await this.findByToken(rawToken);
    const clientId = this.config.get<string>('MICROSOFT_CLIENT_ID');
    if (!clientId) throw new BadRequestException('Microsoft connect is not configured');

    const state = this.signState({
      inviteId: invite.id,
      exp: Date.now() + 30 * 60 * 1000,
      nonce: randomBytes(8).toString('hex'),
    });
    const redirectUri = `${this.publicApiBase}/onboard-api/it/microsoft/callback`;
    const url =
      `https://login.microsoftonline.com/organizations/adminconsent` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&state=${encodeURIComponent(state)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return { url };
  }

  /**
   * Entra redirects here after the customer's global admin accepts (or
   * declines). Returns the onboarding-web URL to 302 to.
   */
  async handleMicrosoftCallback(query: {
    state?: string;
    admin_consent?: string;
    tenant?: string;
    error?: string;
    error_description?: string;
  }): Promise<string> {
    let state: ConsentState;
    try {
      state = this.verifyState(query.state ?? '');
    } catch {
      this.logger.warn('IT-admin consent callback with bad state — rejecting');
      return `${this.publicWebBase}/it/error?reason=state`;
    }

    const invite = await this.prisma.onboardItInvite.findUnique({
      where: { id: state.inviteId },
    });
    if (!invite) return `${this.publicWebBase}/it/error?reason=missing`;

    const consented = (query.admin_consent ?? '').toLowerCase() === 'true';
    if (!consented) {
      this.logger.warn(
        `IT-admin consent declined/failed for invite ${invite.id}: ${query.error ?? ''} ${query.error_description ?? ''}`,
      );
      await this.prisma.onboardItInvite.update({
        where: { id: invite.id },
        data: { status: 'failed' },
      });
      return `${this.publicWebBase}/it/error?reason=declined`;
    }

    await this.prisma.onboardItInvite.update({
      where: { id: invite.id },
      data: {
        status: 'granted',
        provider: 'microsoft',
        entraTenantId: query.tenant ?? null,
        grantedAt: new Date(),
      },
    });
    // Org-wide grant lands → the it_email task completes (Gherkin: only the
    // send-team-invites step gates on this).
    await this.prisma.onboardSetupTask.updateMany({
      where: { tenantId: invite.tenantId, task: 'it_email', status: { not: 'done' } },
      data: { status: 'done', completedBy: `it:${invite.email}`, completedAt: new Date() },
    });
    this.logger.log(
      `IT-admin consent granted for tenant ${invite.tenantId} (entra ${query.tenant ?? '?'})`,
    );
    return `${this.publicWebBase}/it/done`;
  }

  private signState(state: ConsentState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
    const sig = createHmac('sha256', this.stateSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  private verifyState(raw: string): ConsentState {
    const [payload, sig] = raw.split('.');
    if (!payload || !sig) throw new ForbiddenException('Bad state');
    const expected = createHmac('sha256', this.stateSecret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Bad state signature');
    }
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConsentState;
    if (!state.inviteId || state.exp < Date.now()) throw new ForbiddenException('State expired');
    return state;
  }
}
