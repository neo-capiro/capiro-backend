import { Injectable } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GmailSendService } from './google/gmail-send.service.js';
import type { EngagementMailSendResult } from './mail-send-result.js';

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
  /**
   * Phase 0 — our own delivery id, stamped into the outbound message headers as
   * `X-Capiro-Delivery-Id` so a message later found in Sent Items can be tied
   * back to the exact outreach_deliveries row.
   *
   * This is OUTBOUND correlation for reconciliation only. It is not a tracking
   * pixel, adds no recipient-side telemetry, and nothing reports back to us when
   * the message is opened.
   */
  correlationId?: string;
}

// The send-result contract + AmbiguousMailSendError live in the dependency-free
// ./mail-send-result.js leaf so the adapters can import the error class at
// runtime without cycling back through this module (which imports them).
// Re-exported here so callers still have one import site.
export {
  AmbiguousMailSendError,
  type EngagementMailSendResult,
} from './mail-send-result.js';

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

  /**
   * Dispatch to the owning provider adapter and return its FULL result verbatim.
   *
   * Deliberately does not catch or rewrite provider exceptions beyond this
   * dispatch: an AmbiguousMailSendError in particular must reach the send-intent
   * worker intact, because collapsing it into a generic failure is exactly how an
   * already-delivered message gets re-sent.
   */
  async sendMail(
    ctx: TenantContext,
    connection: SendableConnection,
    input: EngagementSendMailInput,
  ): Promise<EngagementMailSendResult> {
    if (connection.provider === EngagementProvider.google_workspace) {
      return this.gmailSend.sendMail(ctx, connection.id, input);
    }
    // microsoft_365 (and any future non-Google provider a resolver returns).
    return this.microsoftGraph.sendMail(ctx, connection.id, input);
  }
}
