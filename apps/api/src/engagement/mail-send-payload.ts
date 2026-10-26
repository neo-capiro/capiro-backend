import { BadRequestException } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import { buildGmailRawMessage } from './google/gmail-send.service.js';
import { definiteMailSendRejection } from './mail-send-result.js';
import type { EngagementSendMailInput } from './mail-sender.service.js';
import { buildMicrosoftSendPayload } from './microsoft/microsoft-send-payload.js';

// Graph documents a 4 MB write-request ceiling; use decimal bytes conservatively.
// https://learn.microsoft.com/en-us/graph/use-the-api#http-methods
const GRAPH_REQUEST_MAX_BYTES = 4_000_000;
// Google's messages.send media limit is 35 MiB. Apply that limit conservatively
// to the larger JSON request envelope, including MIME's outer base64url encoding.
// https://gmail.googleapis.com/$discovery/rest?version=v1
const GMAIL_REQUEST_MAX_BYTES = 36_700_160;

/** Measure the owning serializer's complete request without provider I/O. */
export function assertMailPayloadSize(
  provider: EngagementProvider,
  input: EngagementSendMailInput,
): void {
  const google = provider === EngagementProvider.google_workspace;
  const payload = google ? { raw: buildGmailRawMessage(input) } : buildMicrosoftSendPayload(input);
  const maxBytes = google ? GMAIL_REQUEST_MAX_BYTES : GRAPH_REQUEST_MAX_BYTES;
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxBytes) {
    throw definiteMailSendRejection(
      new BadRequestException({
        code: 'MAIL_PAYLOAD_TOO_LARGE',
        provider: google ? 'gmail' : 'microsoft_graph',
        maxBytes,
        message: `Email exceeds the supported ${google ? 'Gmail' : 'Outlook'} request size after encoding. Reduce the message or attachments, then review the email again.`,
      }),
    );
  }
}
