import { capturedGmailReplyRecipients, replyRecipientsMatch } from '../mail-reply-recipients.js';
// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Gmail send adapter — the Google Workspace analog of the Microsoft Graph
// sendMail path. It resolves the caller's own OAuth token via the shared
// GoogleTokenService, assembles an RFC 2822 MIME message, and posts it to the
// Gmail users.messages.send endpoint. Do NOT modify the auth/token handling or
// the wire format without EXPLICIT prior approval from Neo.
// ============================================================================
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { buildMailMime } from '../mail-mime.js';
export { sanitizeCorrelationId } from '../mail-mime.js';
import type { TenantContext } from '@capiro/shared';
import { GoogleTokenService } from './google-token.service.js';
import { mailboxProviderRequest } from '../mailbox-provider-transport.js';
import type { EngagementSendMailInput } from '../mail-sender.service.js';
import { gmailReplyIdentity, REPLY_UNAVAILABLE } from '../single-mail-reply.js';
import {
  AmbiguousMailSendError,
  definiteMailSendRejection,
  isAmbiguousTransportFailure,
  type EngagementMailSendResult,
} from '../mail-send-result.js';

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

@Injectable()
export class GmailSendService {
  private readonly logger = new Logger(GmailSendService.name);

  constructor(private readonly googleToken: GoogleTokenService) {}

  /**
   * Send through the caller's own Gmail mailbox.
   *
   * Phase 0 (§3.e2, change-control approved): the returned message resource is
   * now PARSED and surfaced instead of discarded, so a delivery row can record
   * Gmail's own message/thread ids. Auth, token refresh, scopes, the CR/LF
   * header-injection guards, MIME encoding and attachment handling are unchanged.
   */
  async sendMail(
    ctx: TenantContext,
    connectionId: string,
    input: EngagementSendMailInput,
  ): Promise<EngagementMailSendResult> {
    const { connection, token } = await this.googleToken.loadConnection(ctx.tenantId, connectionId);
    // Defence in depth — resolvers already scope to the caller, but never send
    // through a mailbox the requesting user doesn't own (matches the Microsoft
    // adapter's assertConnectionAccess).
    if (connection.createdByUserId !== ctx.userId) {
      throw new ForbiddenException('You can only send from your own Google account');
    }
    const accessToken = await this.googleToken.getValidAccessToken(
      ctx.tenantId,
      connectionId,
      token,
    );

    const reply = input.reply;
    if (reply?.kind === 'microsoft_graph') throw definiteMailSendRejection(new BadRequestException(REPLY_UNAVAILABLE));
    const request = buildGmailSendPayload(input);
    const correlationId = input.correlationId ?? '';
    if (reply) {
      // Read-only source proof immediately before the sole send. No GET failure
      // can fall through to dispatch. This does not make provider deletion atomic.
      const query = new URLSearchParams({ format: 'metadata' });
      for (const name of ['From', 'Reply-To', 'Subject', 'Message-ID', 'References', ...(input.replyAll ? ['To', 'Cc'] : [])]) query.append('metadataHeaders', name);
      const original = await mailboxProviderRequest(async signal => {
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(reply.messageId)}?${query}`, {
          method: 'GET', signal, headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (response.status === 404 || response.status === 410)
          throw definiteMailSendRejection(new BadRequestException(REPLY_UNAVAILABLE));
        if (!response.ok) throw new ServiceUnavailableException('The original message could not be verified. No reply was dispatched.');
        return response.json();
      });
      if (JSON.stringify(gmailReplyIdentity(original)) !== JSON.stringify(reply) ||
          (input.replyAll && JSON.stringify(capturedGmailReplyRecipients(original)) !== JSON.stringify(input.replyAll.original)))
        throw definiteMailSendRejection(new BadRequestException('The original message changed. Review it again before replying.'));
    }

    // The request may die on the wire AFTER the body was transmitted, in which
    // case Gmail may already have accepted the message. That is genuinely
    // ambiguous, not a failure: letting the raw transport error escape would have
    // the send-intent worker record 'failed' and offer the user a retry, which can
    // duplicate a delivered email. The deadline includes reading the response
    // body; a timed-out send is never retried by this adapter.
    let response: Response;
    let payload: unknown;
    try {
      const received = await mailboxProviderRequest(async (signal) => {
        const response = await fetch(GMAIL_SEND_URL, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const payload = response.ok
          ? await response.json().catch(() => {
              throw new AmbiguousMailSendError(
                'Gmail accepted the message but its response could not be read; verify Sent Items.',
                correlationId,
              );
            })
          : await response.text().catch(() => '');
        return { response, payload };
      });
      response = received.response;
      payload = received.payload;
    } catch (err) {
      if (isAmbiguousTransportFailure(err)) {
        throw new AmbiguousMailSendError(
          'The connection to Gmail failed before a result was returned; verify Sent Items before resending.',
          correlationId,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = typeof payload === 'string' ? payload : '';
      // 403 insufficient scope => the connection was granted before gmail.send
      // was added to the scope set; the user must reconnect to re-consent.
      if (
        response.status === 403 &&
        /insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)
      ) {
        throw definiteMailSendRejection(
          new BadRequestException(
            'Reconnect Google Workspace in Settings to grant Capiro permission to send email on your behalf.',
          ),
        );
      }
      if (response.status === 401) {
        throw definiteMailSendRejection(
          new BadRequestException(
            'Reconnect Google Workspace in Settings to continue sending email.',
          ),
        );
      }
      // §g5 / Open Decision 6.3 — a 5xx is Gmail's OWN failure while handling
      // the request, not a confirmed rejection of it. Unlike the 4xx cases
      // above (the request itself was refused — known, plain failure), a 5xx
      // does not guarantee the message was never accepted before the response
      // failed to complete, so it is genuinely ambiguous, the same as a
      // transport-level failure.
      if (response.status >= 500) {
        throw new AmbiguousMailSendError(
          `Gmail returned a server error (${response.status}); verify Sent Items before resending.`,
          correlationId,
        );
      }
      throw definiteMailSendRejection(
        new ServiceUnavailableException(
          `Gmail send failed (${response.status}): ${text.slice(0, 300)}`,
        ),
      );
    }

    // HTTP 200 means Gmail ACCEPTED the message. From here on, failing loudly
    // would be wrong: the mail is already gone. A response we cannot read, or one
    // without an id, is genuinely AMBIGUOUS — the caller records the delivery as
    // 'unknown' and never retries it (a retry would duplicate a delivered email).
    const parsed = payload as { id?: unknown; threadId?: unknown } | null;
    const messageId = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    if (!messageId) {
      throw new AmbiguousMailSendError(
        'Gmail returned success without a message id; verify Sent Items before resending.',
        correlationId,
      );
    }
    const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
    return {
      ok: true,
      provider: 'gmail',
      providerMessageId: messageId,
      ...(threadId ? { providerThreadId: threadId } : {}),
      correlationId,
    };
  }
}

// ---- RFC 2822 MIME assembly (module-private, exported for unit tests) --------

/**
 * Build the base64url-encoded `raw` message for Gmail users.messages.send.
 * Bodies and attachments are base64-encoded (line-wrapped at 76 chars) so long
 * HTML lines and 8-bit content never violate SMTP line limits. The `From`
 * header is intentionally omitted — Gmail stamps the authenticated user's own
 * address, which also avoids "From must match a send-as alias" rejections.
 */
export function buildGmailRawMessage(input: EngagementSendMailInput): string {
  return buildMailMime(input).toString('base64url');
}

/** One complete request serializer shared by admission sizing and provider dispatch. */
export function buildGmailSendPayload(input: EngagementSendMailInput) {
  if ((input.replyAll && !input.reply) || input.reply?.kind === 'microsoft_graph') throw definiteMailSendRejection(new BadRequestException(REPLY_UNAVAILABLE));
  if (input.reply && (input.subject !== input.reply.subject || !replyRecipientsMatch(input.reply.toEmail, input.replyAll, input.toRecipients, input.ccRecipients, input.bccRecipients) ||
      /[\r\n]/.test(input.reply.inReplyTo + input.reply.references)))
    throw definiteMailSendRejection(new BadRequestException(REPLY_UNAVAILABLE));
  return { raw: buildGmailRawMessage(input), ...(input.reply ? { threadId: input.reply.threadId } : {}) };
}
