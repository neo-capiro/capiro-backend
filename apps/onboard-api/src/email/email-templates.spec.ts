import {
  renderConfirmationEmail,
  renderItAdminInviteEmail,
  renderReceiptEmail,
} from './email-templates.js';

describe('email-templates', () => {
  describe('renderReceiptEmail (plan × method matrix)', () => {
    it('trial: $0 today, day-31 conversion, amount due, method on file', () => {
      const email = renderReceiptEmail({
        plan: 'trial',
        method: 'card',
        profiles: 10,
        orgName: 'Aperture Defense',
      });
      expect(email.subject).toContain('$0');
      expect(email.text).toContain('$0 charged today.');
      expect(email.text).toContain('day 31');
      expect(email.text).toContain('$2,000/month');
      expect(email.text).toContain('Card on file');
      expect(email.html).toContain('day 31');
    });

    it('trial wire: wire instructions note instead of a stored method', () => {
      const email = renderReceiptEmail({
        plan: 'trial',
        method: 'wire',
        profiles: 10,
        orgName: 'Aperture Defense',
      });
      expect(email.text).toContain('Billed by wire');
    });

    it('paid card: amount charged, profiles, billing cycle start', () => {
      const email = renderReceiptEmail({
        plan: 'paid',
        method: 'card',
        profiles: 25,
        orgName: 'Aperture Defense',
        billedAt: new Date('2026-07-06T12:00:00Z'),
      });
      expect(email.subject).toContain('$5,000');
      expect(email.text).toContain('$5,000 charged on July 6, 2026');
      expect(email.text).toContain('25 client profiles × $200/profile');
      expect(email.text).toContain('billing cycle starts July 6, 2026');
    });

    it('paid wire: amount due, instructions note, and due date', () => {
      const email = renderReceiptEmail({
        plan: 'paid',
        method: 'wire',
        profiles: 10,
        orgName: 'Aperture Defense',
        wireDueDate: new Date('2026-07-20T12:00:00Z'),
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/test',
      });
      expect(email.text).toContain('Amount due: $2,000');
      expect(email.text).toContain('wire instructions are on your invoice');
      expect(email.text).toContain('Due by July 20, 2026');
      expect(email.html).toContain('https://invoice.stripe.com/i/test');
    });

    it('paid ach: amount due plus the 1–3 business day clearing note', () => {
      const email = renderReceiptEmail({
        plan: 'paid',
        method: 'ach',
        profiles: 12,
        orgName: 'Aperture Defense',
      });
      expect(email.text).toContain('Amount due: $2,400');
      expect(email.text).toContain('1–3 business days');
    });

    it('clamps profiles below the minimum to 10', () => {
      const email = renderReceiptEmail({
        plan: 'paid',
        method: 'card',
        profiles: 3,
        orgName: 'Aperture Defense',
      });
      expect(email.text).toContain('10 client profiles');
    });
  });

  describe('renderConfirmationEmail', () => {
    it('uses the approved trial copy (never "Trial started")', () => {
      const email = renderConfirmationEmail({
        firstName: 'Jordan',
        orgName: 'Aperture Defense',
        plan: 'trial',
        adminSummaries: ['jane@firm.com (Super Admin)'],
        itAdminEmails: ['it@firm.com'],
      });
      expect(email.text).toContain('30-day free trial begins the day your firm finishes');
      expect(email.text).not.toContain('Trial started');
      expect(email.text).toContain('app.capiro.ai');
      expect(email.text).toContain('jane@firm.com (Super Admin)');
      expect(email.text).toContain('it@firm.com');
      expect(email.html).toContain('Platform created');
    });

    it('escapes HTML in interpolated values', () => {
      const email = renderConfirmationEmail({
        orgName: 'Smith & Sons <LLP>',
        plan: 'paid',
        adminSummaries: [],
        itAdminEmails: [],
      });
      expect(email.html).toContain('Smith &amp; Sons &lt;LLP&gt;');
      expect(email.html).not.toContain('<LLP>');
    });
  });

  describe('renderItAdminInviteEmail', () => {
    it('carries the tokened link and the firm name', () => {
      const email = renderItAdminInviteEmail(
        'https://onboarding.capiro.ai/it/abc123',
        'Aperture Defense',
      );
      expect(email.subject).toContain('Aperture Defense');
      expect(email.text).toContain('https://onboarding.capiro.ai/it/abc123');
      expect(email.html).toContain('https://onboarding.capiro.ai/it/abc123');
      expect(email.text).toContain('expires in 7 days');
    });
  });
});
