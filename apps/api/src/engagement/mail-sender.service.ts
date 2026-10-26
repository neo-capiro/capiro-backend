import { BadRequestException, Injectable } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GmailSendService, buildGmailRawMessage } from './google/gmail-send.service.js';
import { definiteMailSendRejection, type EngagementMailSendResult } from './mail-send-result.js';
import { buildMicrosoftSendPayload } from './microsoft/microsoft-send-payload.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

// Graph documents a 4 MB write-request ceiling; use decimal bytes conservatively.
// https://learn.microsoft.com/en-us/graph/use-the-api#http-methods
const GRAPH_REQUEST_MAX_BYTES = 4_000_000;
// Google's messages.send media limit is 35 MiB. Apply that limit conservatively
// to the larger JSON request envelope, including MIME's outer base64url encoding.
// https://gmail.googleapis.com/$discovery/rest?version=v1
const GMAIL_REQUEST_MAX_BYTES = 36_700_160;

/**
 * Provider-neutral outbound-email payload. Structurally identical to
 * MicrosoftGraphSendMailInput (so it passes straight through to Graph) and
 * consumed verbatim by the Gmail MIME builder — one shape, both providers.
 */
export type EngagementSendRuntimeAction =
  | 'outreach_send'
  | 'outreach_test_send'
  | 'outreach_v3_send'
  | 'outreach_v3_test_send';

export interface EngagementSendMailInput {
  /** Internal-only marker consumed by guarded provider adapters. */
  runtimeAction?: EngagementSendRuntimeAction;
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
export { AmbiguousMailSendError, type EngagementMailSendResult } from './mail-send-result.js';

/** The minimum a resolved sending connection must carry for routing. */
export interface SendableConnection {
  id: string;
  provider: EngagementProvider;
}

/**
 * The provider slug that gets PERSISTED alongside a send (delivery rows,
 * OutreachRecord.stats, campaignSend metadata).
 *
 * One helper, because every site that hardcoded `'microsoft_graph'` was silently
 * wrong for a Gmail sender — a real defect this codebase carried on the batch and
 * campaign paths (plan §1 item 8). Derived from the same connection enum
 * `sendMail()` above routes on, so the recorded provider and the provider that
 * actually delivered can never disagree.
 */
export function sendProviderSlug(provider: EngagementProvider): 'microsoft_graph' | 'gmail' {
  return provider === EngagementProvider.google_workspace ? 'gmail' : 'microsoft_graph';
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
    private readonly runtimePolicy: EngagementRuntimePolicyService,
  ) {}

  /**
   * Dispatch to the owning provider adapter and return its FULL result verbatim.
   *
   * Engagement API Phase 1 — defense-in-depth: assert outreach_send before
   * any provider adapter is called. The OutreachSendIntentService owns the
   * test-only exception before dispatch; here we always assert outreach_send.
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
    runtimeAction: EngagementSendRuntimeAction = 'outreach_send',
  ): Promise<EngagementMailSendResult> {
    this.runtimePolicy.assertExternalAction(runtimeAction, {
      testMode: runtimeAction === 'outreach_test_send' || runtimeAction === 'outreach_v3_test_send',
    });
    const providerInput: EngagementSendMailInput = { ...input, runtimeAction };
    // Callers already rendered the body/signature and loaded exact attachment
    // bytes. Measure the owning serializer's complete request before the adapter
    // can refresh credentials, create a draft, upload anything or send. This
    // local refusal proves no provider acceptance; dispatched failures keep their
    // existing ambiguous-outcome classification and are never retried here.
    const google = connection.provider === EngagementProvider.google_workspace;
    const payload = google
      ? { raw: buildGmailRawMessage(providerInput) }
      : buildMicrosoftSendPayload(providerInput);
    const maxBytes = google ? GMAIL_REQUEST_MAX_BYTES : GRAPH_REQUEST_MAX_BYTES;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxBytes) {
      throw definiteMailSendRejection(
        new BadRequestException({
          code: 'MAIL_PAYLOAD_TOO_LARGE',
          provider: sendProviderSlug(connection.provider),
          maxBytes,
          message: `Email exceeds the ${google ? 'Gmail' : 'Outlook'} request size limit after encoding. Reduce the message or attachments, or use an authorized document link.`,
        }),
      );
    }
    if (connection.provider === EngagementProvider.google_workspace) {
      return this.gmailSend.sendMail(ctx, connection.id, providerInput);
    }
    // microsoft_365 (and any future non-Google provider a resolver returns).
    return this.microsoftGraph.sendMail(ctx, connection.id, providerInput);
  }
}
