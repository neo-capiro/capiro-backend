import { Injectable } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GmailSendService } from './google/gmail-send.service.js';

/**
 * Provider-neutral outbound-email payload. Structurally identical to
 * MicrosoftGraphSendMailInput (so it passes straight through to Graph) and
 * consumed verbatim by the Gmail MIME builder — one shape, both providers.
 */
export interface EngagementSendMailInput {
  subject: string;
  body: string;
  /** Body content type. Defaults to 'Text'; outreach sends HTML drafts as 'HTML'. */
  bodyContentType?: 'Text' | 'HTML';
  toRecipients: Array<{ email: string; name?: string | null }>;
  ccRecipients?: Array<{ email: string; name?: string | null }>;
  bccRecipients?: Array<{ email: string; name?: string | null }>;
  /** Inline file attachments (base64 contentBytes). */
  attachments?: Array<{ name: string; contentType: string; contentBytes: string }>;
}

/** The minimum a resolved sending connection must carry for routing. */
export interface SendableConnection {
  id: string;
  provider: EngagementProvider;
}

/**
 * Routes an outbound email to the correct provider adapter based on the
 * resolved connection. Every send site in the app dispatches through this so a
 * user's Gmail *or* Outlook mailbox works everywhere identically. Deliberately
 * tiny and side-effect-free beyond the delegated send — the change-controlled
 * Microsoft/Google adapters own auth, token refresh, and the wire format.
 */
@Injectable()
export class EngagementMailSender {
  constructor(
    private readonly microsoftGraph: MicrosoftGraphSyncService,
    private readonly gmailSend: GmailSendService,
  ) {}

  async sendMail(
    ctx: TenantContext,
    connection: SendableConnection,
    input: EngagementSendMailInput,
  ): Promise<{ ok: boolean }> {
    if (connection.provider === EngagementProvider.google_workspace) {
      return this.gmailSend.sendMail(ctx, connection.id, input);
    }
    // microsoft_365 (and any future non-Google provider a resolver returns).
    return this.microsoftGraph.sendMail(ctx, connection.id, input);
  }
}
