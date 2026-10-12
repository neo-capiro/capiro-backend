import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

/** Compatibility analysis uses Mailtrap's sandbox only; recipient delivery stays in Outreach. */
@Injectable()
export class NewsletterHtmlCheckService {
  constructor(private readonly env: ConfigService) {}
  private settings() {
    const token = this.env.get<string>('MAILTRAP_API_TOKEN');
    const account = this.env.get<string>('MAILTRAP_ACCOUNT_ID');
    const inbox = this.env.get<string>('MAILTRAP_SANDBOX_ID');
    return token && /^\d+$/.test(account || '') && /^\d+$/.test(inbox || '')
      ? { token, account: account!, inbox: inbox! }
      : null;
  }
  available() {
    return !!this.settings();
  }
  private async request(url: string, token: string, body?: object): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Mailtrap HTML Check is unavailable. The sandbox submission was not retried automatically.',
      );
    }
    if (!response.ok) {
      if (response.status === 429)
        throw new ServiceUnavailableException(
          'Mailtrap’s sandbox limit has been reached. Use Outreach’s test email or try again later.',
        );
      throw new ServiceUnavailableException(
        'Mailtrap HTML Check could not complete. Check the sandbox connection.',
      );
    }
    try {
      return await response.json();
    } catch {
      throw new ServiceUnavailableException('Mailtrap returned an unreadable HTML report.');
    }
  }
  async check(html: string) {
    const settings = this.settings();
    if (!settings)
      throw new ServiceUnavailableException(
        'Connect a Mailtrap sandbox to run HTML compatibility checks.',
      );
    const { token, account, inbox } = settings;
    const subject = `Capiro HTML check ${randomUUID()}`;
    const sent = (await this.request(`https://sandbox.api.mailtrap.io/api/send/${inbox}`, token, {
      from: { email: 'newsletter-check@example.com', name: 'Capiro HTML Check' },
      to: [{ email: 'sandbox-preview@example.com' }],
      subject,
      html,
    })) as { success?: boolean } | null;
    if (!sent?.success)
      throw new ServiceUnavailableException('Mailtrap did not accept the HTML check.');
    // Send response IDs are strings. Resolve the integer analysis ID using our
    // unique subject, rather than assuming those IDs have the same wire format.
    const base = `https://mailtrap.io/api/accounts/${account}/inboxes/${inbox}/messages`;
    let messageId: number | null = null;
    for (let attempt = 0; attempt < 4 && !messageId; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
      const messages = await this.request(`${base}?search=${encodeURIComponent(subject)}`, token);
      if (Array.isArray(messages)) {
        const message = messages.find(
          (item) => item?.subject === subject && Number.isSafeInteger(item?.id) && item.id > 0,
        );
        if (message) messageId = message.id;
      }
    }
    if (!messageId)
      throw new ServiceUnavailableException(
        'Mailtrap has not finished receiving the HTML check. Try again later.',
      );
    const report = await this.request(`${base}/${messageId}/analyze`, token);
    if (!report || typeof report !== 'object' || Array.isArray(report))
      throw new ServiceUnavailableException('Mailtrap returned an unsupported HTML report.');
    const value = report as Record<string, unknown>;
    if (value.status !== 'success' || !Array.isArray(value.errors))
      throw new ServiceUnavailableException(
        'Mailtrap could not analyze this HTML. Inspect the sandbox report for details.',
      );
    const issues = value.errors
      .slice(0, 200)
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
    return { provider: 'Mailtrap', issues, report: value };
  }
}
