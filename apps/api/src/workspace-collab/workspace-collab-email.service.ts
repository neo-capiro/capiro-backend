import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import type { SendInviteEmailDto } from './workspace-collab.dto.js';

export interface EmailSendResult {
  sent: boolean;
  messageId?: string;
  error?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Workspace collaborator-invite email via SESv2 (E-19) — same path as the
 * Tracker alert + demo-request emails (capiro.ai is a verified SES domain).
 * Best-effort: a send failure is logged and surfaced, never thrown, so the
 * in-app notification (the source of truth) is unaffected.
 */
@Injectable()
export class WorkspaceCollabEmailService {
  private readonly logger = new Logger(WorkspaceCollabEmailService.name);
  private readonly ses: SESv2Client;
  private readonly from: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const region = config.get('AWS_REGION_DEFAULT', { infer: true });
    this.ses = new SESv2Client({ region });
    this.from = config.get('WORKSPACE_INVITE_EMAIL_FROM', { infer: true });
  }

  async sendInvite(dto: SendInviteEmailDto): Promise<EmailSendResult> {
    const inviter = dto.inviterName?.trim() || 'A teammate';
    const greeting = dto.toName?.trim() ? `Hi ${escapeHtml(dto.toName.trim())},` : 'Hi,';
    const subject = `${inviter} invited you to collaborate on “${dto.draftTitle}”`;
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5">
        <p>${greeting}</p>
        <p>${escapeHtml(inviter)} invited you to collaborate on
           <strong>${escapeHtml(dto.draftTitle)}</strong> in Capiro Workspace as
           <strong>${escapeHtml(dto.role)}</strong>.</p>
        <p>You can accept or decline from your notifications in the app.</p>
        <p><a href="${dto.link}" style="display:inline-block;background:#3b5bdb;color:#fff;text-decoration:none;padding:9px 16px;border-radius:7px;font-weight:600">Open in Capiro</a></p>
        <p style="color:#888;font-size:12px">If you didn't expect this, you can ignore this email.</p>
      </div>`;
    const text = `${inviter} invited you to collaborate on "${dto.draftTitle}" in Capiro Workspace as ${dto.role}.\n\nAccept or decline from your notifications in the app: ${dto.link}\n\nIf you didn't expect this, you can ignore this email.`;

    try {
      const res = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [dto.toEmail] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: html, Charset: 'UTF-8' },
                Text: { Data: text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      return { sent: true, messageId: res.MessageId };
    } catch (e) {
      this.logger.error(`Workspace invite email to ${dto.toEmail} failed: ${(e as Error).message}`);
      return { sent: false, error: (e as Error).message };
    }
  }
}
