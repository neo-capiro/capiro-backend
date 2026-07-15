import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GOOGLE_WORKSPACE_REQUIRED_GRANTS, GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** Signed state carried through the provider consent/verify round-trips. */
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
  /** Which providers this deployment can actually run — fail-closed dark:
   *  the UI renders an unconfigured provider's button disabled. */
  providers: { microsoft: boolean; google: boolean };
  /** Public OAuth client id shown in the Workspace trusted-app instructions
   *  (client ids are not secrets). Null until Google is configured. */
  googleClientId: string | null;
}

// The scope set the test-connect requests must equal exactly what team members
// request when connecting their own mailbox (the apps/api engagement
// integration), or the verification lies — a slimmer set would pass even where
// real connects fail. Both sides import the single source of truth in
// @capiro/shared (GOOGLE_WORKSPACE_SCOPES); a parity test pins the engagement
// copy to it so the two can't drift.
const GOOGLE_VERIFY_SCOPES = [...GOOGLE_WORKSPACE_SCOPES];
// The identity scopes are granted implicitly; only the Gmail/Calendar grants
// prove the Workspace actually allows the app.
const GOOGLE_REQUIRED_GRANTS = GOOGLE_WORKSPACE_REQUIRED_GRANTS;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface GoogleTokenResponse {
  access_token?: string;
  scope?: string;
  id_token?: string;
}

/** Lower-cased domain part of an email address, or null if it isn't one. */
function emailDomain(email: string | undefined | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * IT-admin authorization path (Gherkin "IT Admin"): the invited email-provider
 * admin has NO Capiro account — the emailed link carries a single-purpose
 * token (stored hashed) that opens the one-task connect page.
 *
 * Microsoft: the "Connect with Microsoft" button sends the admin to Entra's
 * tenant-wide admin-consent endpoint for the existing multi-tenant Capiro app
 * (MICROSOFT_CLIENT_ID, the same app users connect mailboxes to). On the
 * signed-state callback with admin_consent=True we record the customer's
 * Entra tenant id, mark the invite granted, and flip the it_email setup task
 * to done — unlocking nothing else (Gherkin: only "Send team invites" gates
 * on it). Full "verified" status upgrades when the first user mailbox
 * connect succeeds (engagement-side signal, follow-up).
 *
 * Google has NO tenant-wide admin-consent URL. The Workspace equivalent
 * (decision Q5, now unblocked by the shipped Gmail engagement integration) is:
 * the admin marks the Capiro OAuth client Trusted in the Google Admin console
 * (Security → API controls → App access control) — which both expresses org
 * approval AND exempts the app from Google's unverified-app block for that
 * domain — then proves it worked with a test-connect: a normal OAuth
 * code-flow sign-in requesting the same scopes users will request. On a
 * successful exchange we record the Workspace domain (`hd` claim), mark the
 * invite granted, and flip it_email; the tokens themselves are DISCARDED —
 * this path verifies authorization, it does not create a mailbox connection.
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

  private get googleClientId(): string | undefined {
    return this.config.get<string>('GOOGLE_CLIENT_ID') || undefined;
  }

  private get googleConfigured(): boolean {
    return Boolean(this.googleClientId && this.config.get<string>('GOOGLE_CLIENT_SECRET'));
  }

  async getInvite(rawToken: string): Promise<ItInviteView> {
    const invite = await this.findByToken(rawToken);
    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({ where: { id: invite.tenantId }, select: { name: true } }),
    );
    const googleConfigured = this.googleConfigured;
    return {
      orgName: tenant?.name ?? 'your firm',
      email: invite.email,
      status: invite.status,
      provider: invite.provider,
      providers: {
        microsoft: Boolean(this.config.get<string>('MICROSOFT_CLIENT_ID')),
        google: googleConfigured,
      },
      googleClientId: googleConfigured ? this.googleClientId! : null,
    };
  }

  /** Build the provider authorization URL for this invite: Entra tenant-wide
   *  admin-consent (microsoft) or the Workspace test-connect OAuth flow
   *  (google). */
  async buildConsentUrl(rawToken: string, provider: string): Promise<{ url: string }> {
    if (provider === 'google') return this.buildGoogleVerifyUrl(rawToken);
    if (provider !== 'microsoft') {
      throw new BadRequestException('Unknown provider');
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

  private async buildGoogleVerifyUrl(rawToken: string): Promise<{ url: string }> {
    const invite = await this.findByToken(rawToken);
    // Fail-closed dark (same posture as the engagement integration): without
    // both GOOGLE_* values the button renders disabled and this path 400s.
    if (!this.googleConfigured) throw new BadRequestException('Google connect is not configured');

    const state = this.signState({
      inviteId: invite.id,
      exp: Date.now() + 30 * 60 * 1000,
      nonce: randomBytes(8).toString('hex'),
    });
    const params = new URLSearchParams({
      client_id: this.googleClientId!,
      redirect_uri: `${this.publicApiBase}/onboard-api/it/google/callback`,
      response_type: 'code',
      scope: GOOGLE_VERIFY_SCOPES.join(' '),
      // No access_type=offline: we never want a refresh token here — the
      // exchange only proves the grant works, then the tokens are discarded.
      // prompt=consent forces the full scope screen so the verification can't
      // silently ride a previous partial grant.
      prompt: 'consent',
      login_hint: invite.email,
      state,
    });
    return { url: `${GOOGLE_AUTH_URL}?${params.toString()}` };
  }

  /**
   * The invited admin defers Google verification instead of completing it now
   * (Google's Testing-mode publishing status means most customers can't
   * actually finish this today — see decision log). Marks the invite/task
   * 'skipped', which satisfies the completeSetup gate the same as 'done'. The
   * token is NOT consumed: reopening the same link later re-enters the normal
   * choose/verify flow (getInvite reports status:'skipped', not granted).
   * Never downgrades an already-successful grant.
   */
  async skipGoogleVerification(rawToken: string): Promise<{ ok: true }> {
    const invite = await this.findByToken(rawToken);
    if (invite.status === 'granted' || invite.status === 'verified') {
      return { ok: true };
    }
    await this.prisma.onboardItInvite.update({
      where: { id: invite.id },
      data: { status: 'skipped', provider: 'google' },
    });
    await this.prisma.onboardSetupTask.updateMany({
      where: { tenantId: invite.tenantId, task: 'it_email', status: { not: 'done' } },
      data: { status: 'skipped', completedBy: `it:${invite.email}`, completedAt: new Date() },
    });
    this.logger.log(
      `IT-admin Google verify skipped for tenant ${invite.tenantId} (invite ${invite.id})`,
    );
    return { ok: true };
  }

  /** A callback replay after a completed grant must be idempotent: a browser
   *  refresh/back re-hits the redirect target, and re-exchanging a single-use
   *  Google code throws — without this short-circuit that would flip a granted
   *  invite to 'failed' and re-show the connect UI. */
  private doneIfAlreadyGranted(invite: { status: string }): string | null {
    return invite.status === 'granted' || invite.status === 'verified'
      ? `${this.publicWebBase}/it/done`
      : null;
  }

  /** Stale-invite guard: the signed state lives 30 min independently of the
   *  invite's own 7-day window, so an invite revoked (replaced) or expired
   *  after the auth URL was minted must NOT be granted. Not a "failure" of the
   *  admin, so we don't stamp status='failed' here. */
  private staleInviteRedirect(invite: { status: string; expiresAt: Date }): string | null {
    if (invite.status === 'revoked') return `${this.publicWebBase}/it/error?reason=missing`;
    if (invite.expiresAt.getTime() < Date.now()) {
      return `${this.publicWebBase}/it/error?reason=expired`;
    }
    return null;
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
    const already = this.doneIfAlreadyGranted(invite);
    if (already) return already;
    const stale = this.staleInviteRedirect(invite);
    if (stale) return stale;

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

  /**
   * Google redirects here after the customer's Workspace admin completes (or
   * abandons) the test-connect sign-in. Returns the onboarding-web URL to 302
   * to. The exchanged tokens are read for identity (`hd`) and granted scopes
   * only, then dropped — NEVER persisted, and NEVER revoked: revoking would
   * kill the admin's whole user↔client grant, including any real mailbox
   * connection they already made (or later make) in the app.
   */
  async handleGoogleCallback(query: {
    state?: string;
    code?: string;
    error?: string;
    error_description?: string;
  }): Promise<string> {
    let state: ConsentState;
    try {
      state = this.verifyState(query.state ?? '');
    } catch {
      this.logger.warn('IT-admin Google callback with bad state — rejecting');
      return `${this.publicWebBase}/it/error?reason=state`;
    }

    const invite = await this.prisma.onboardItInvite.findUnique({
      where: { id: state.inviteId },
    });
    if (!invite) return `${this.publicWebBase}/it/error?reason=missing`;
    const already = this.doneIfAlreadyGranted(invite);
    if (already) return already;
    const stale = this.staleInviteRedirect(invite);
    if (stale) return stale;

    const fail = async (reason: string): Promise<string> => {
      await this.prisma.onboardItInvite.update({
        where: { id: invite.id },
        data: { status: 'failed' },
      });
      return `${this.publicWebBase}/it/error?reason=${reason}`;
    };

    if (query.error || !query.code) {
      this.logger.warn(
        `IT-admin Google verify declined/failed for invite ${invite.id}: ${query.error ?? 'no code'} ${query.error_description ?? ''}`,
      );
      // admin_policy_enforced = the Workspace blocks this app → the error page
      // shows the trusted-app allowlist instructions instead of a generic
      // "declined".
      return fail(query.error === 'admin_policy_enforced' ? 'policy' : 'declined');
    }

    let token: GoogleTokenResponse;
    try {
      token = await this.exchangeGoogleCode(query.code);
    } catch (err) {
      this.logger.warn(
        `IT-admin Google code exchange failed for invite ${invite.id}: ${(err as Error).message}`,
      );
      return fail('exchange');
    }

    // Google lets the user UNCHECK individual scopes on the consent screen; a
    // grant missing the Gmail/Calendar scopes would "pass" here while every
    // team-member connect still fails, so require them explicitly.
    const granted = new Set((token.scope ?? '').split(/\s+/).filter(Boolean));
    if (!GOOGLE_REQUIRED_GRANTS.every((s) => granted.has(s))) {
      this.logger.warn(
        `IT-admin Google verify for invite ${invite.id} granted only [${token.scope ?? ''}]`,
      );
      return fail('scopes');
    }

    const claims = this.decodeIdTokenClaims(token.id_token);

    // Bind the verification to the invited firm: the whole point is to prove
    // THIS customer's Workspace trusts Capiro, so the account that granted must
    // be on the invited email's domain. Without this an admin whose Workspace
    // blocks the app could satisfy the step with a personal @gmail.com or an
    // unrelated Workspace — it_email flips done while every real team-member
    // connect at the firm still fails. Match against the Workspace primary
    // domain (`hd`) OR the signed-in email's domain (covers domain aliases).
    const inviteDomain = emailDomain(invite.email);
    const authDomains = [claims.hd?.toLowerCase(), emailDomain(claims.email)].filter(
      (d): d is string => Boolean(d),
    );
    if (!inviteDomain || !authDomains.includes(inviteDomain)) {
      this.logger.warn(
        `IT-admin Google verify for invite ${invite.id} used a non-matching account ` +
          `(invite domain ${inviteDomain ?? '?'}, auth domains [${authDomains.join(',')}])`,
      );
      return fail('account');
    }

    await this.prisma.onboardItInvite.update({
      where: { id: invite.id },
      data: {
        status: 'granted',
        provider: 'google',
        googleWorkspaceDomain: claims.hd ?? null,
        grantedAt: new Date(),
      },
    });
    await this.prisma.onboardSetupTask.updateMany({
      where: { tenantId: invite.tenantId, task: 'it_email', status: { not: 'done' } },
      data: { status: 'done', completedBy: `it:${invite.email}`, completedAt: new Date() },
    });
    this.logger.log(
      `IT-admin Google verify granted for tenant ${invite.tenantId} (workspace ${claims.hd ?? 'consumer'})`,
    );
    return `${this.publicWebBase}/it/done`;
  }

  private async exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: this.googleClientId ?? '',
      client_secret: this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '',
      redirect_uri: `${this.publicApiBase}/onboard-api/it/google/callback`,
      grant_type: 'authorization_code',
    });
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BadRequestException(
        `Google token exchange failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    return (await response.json()) as GoogleTokenResponse;
  }

  // The id_token comes to us directly from Google's token endpoint over TLS
  // (never through the browser), so the payload is trusted without signature
  // re-verification — the same trust model as the engagement-side
  // google-oauth.service.
  private decodeIdTokenClaims(idToken?: string): { email?: string; hd?: string } {
    const payloadSegment = idToken?.split('.')[1];
    if (!payloadSegment) return {};
    try {
      return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
        email?: string;
        hd?: string;
      };
    } catch {
      return {};
    }
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
