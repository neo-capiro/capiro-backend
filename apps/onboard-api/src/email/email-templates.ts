import { MIN_CLIENT_SLOTS, monthlySlotCostUsd, pricePerSlotUsd } from '@capiro/shared';

/**
 * Branded HTML+text email templates for the onboarding funnel (Flow 1.11
 * content matrix from the Gherkin/prototype). Pure functions — all state comes
 * in as arguments so templates are unit-testable and safe to render anywhere.
 *
 * Copy rules (plan §5/§8): say `app.capiro.ai` (never `{slug}.capiro.ai`),
 * "Platform created" (never "Tenant provisioned"), and for trials "your
 * 30-day trial begins when your firm finishes setting up its workspace"
 * (never "Trial started").
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Warm-paper palette (prototype design tokens).
const PAPER = '#F4F2EC';
const INK = '#15161A';
const ACCENT = '#2A57CE';
const MUTED = '#5C5E66';
const LINE = '#E3E0D6';

const SANS = "Helvetica,Arial,'Segoe UI',sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Shared shell: Capiro wordmark, white card on warm paper, muted footer. */
function layout(bodyHtml: string): string {
  return (
    `<div style="margin:0;padding:0;background-color:${PAPER};">` +
    `<div style="max-width:560px;margin:0 auto;padding:32px 20px;">` +
    `<div style="font-family:${SANS};font-size:19px;font-weight:700;letter-spacing:0.08em;color:${INK};padding:0 2px 18px;">CAPIRO</div>` +
    `<div style="background:#FFFFFF;border:1px solid ${LINE};border-radius:8px;padding:28px;font-family:${SANS};color:${INK};">` +
    bodyHtml +
    `</div>` +
    `<div style="font-family:${SANS};font-size:11px;color:${MUTED};padding:16px 2px 0;line-height:1.6;">` +
    `Capiro &middot; Government-affairs intelligence &middot; app.capiro.ai<br/>` +
    `Questions? Contact <a href="mailto:support@capiro.ai" style="color:${ACCENT};">support@capiro.ai</a>.` +
    `</div></div></div>`
  );
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:22px;letter-spacing:-0.01em;color:${INK};">${text}</h1>`;
}

function para(html: string): string {
  return `<p style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:${INK};">${html}</p>`;
}

function infoBox(html: string): string {
  return `<div style="background:${PAPER};border:1px solid ${LINE};border-radius:6px;padding:12px 14px;margin:0 0 14px;font-size:12.5px;line-height:1.6;color:${INK};">${html}</div>`;
}

function button(href: string, label: string): string {
  return (
    `<div style="margin:6px 0 16px;">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#FFFFFF;font-family:${SANS};font-size:13.5px;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:6px;">${label}</a>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Confirmation ("Platform created")
// ---------------------------------------------------------------------------

export interface ConfirmationEmailInput {
  firstName?: string | null;
  orgName: string;
  plan: 'trial' | 'paid';
  /** Human-readable admin invite lines, e.g. "jane@firm.com (Super Admin)". */
  adminSummaries: string[];
  itAdminEmails: string[];
}

export function renderConfirmationEmail(input: ConfirmationEmailInput): RenderedEmail {
  const org = escapeHtml(input.orgName);
  const greeting = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : 'Hello,';
  const admins = input.adminSummaries.map(escapeHtml).join(' &middot; ');
  const adminsText = input.adminSummaries.join(', ');
  const trialLine =
    input.plan === 'trial'
      ? 'Your 30-day free trial begins the day your firm finishes setting up its workspace — not today.'
      : '';

  const html = layout(
    heading('Platform created — your workspace is live.') +
      para(greeting) +
      para(
        `Your firm's platform for <b>${org}</b> is created at <b>app.capiro.ai</b> — but setup isn't finished. Your admins take it from here.` +
          (trialLine ? `<br/>${escapeHtml(trialLine)}` : ''),
      ) +
      infoBox(
        `<b>Admin invites sent</b><br/>${admins || 'No additional admins designated.'}` +
          (input.itAdminEmails.length
            ? `<br/>IT admin invite sent to <b>${input.itAdminEmails.map(escapeHtml).join(', ')}</b>`
            : '') +
          `<br/><span style="color:${MUTED};">Each admin gets an email to create their Capiro credentials and sign in — they'll land in the firm setup dashboard.</span>`,
      ) +
      infoBox(
        `<b>What happens next</b><br/>` +
          `1. Admins create credentials and sign in to the setup dashboard<br/>` +
          `2. Firm-level setup: email authorization, client import, AI settings<br/>` +
          `3. The whole team is invited to log in to Capiro`,
      ),
  );

  const text = [
    greeting.replace(/&#39;/g, "'"),
    '',
    'Platform created — your workspace is live.',
    `Your firm's platform for ${input.orgName} is created at app.capiro.ai — but setup isn't finished. Your admins take it from here.`,
    ...(trialLine ? [trialLine] : []),
    '',
    `Admin invites sent: ${adminsText || 'No additional admins designated.'}`,
    ...(input.itAdminEmails.length
      ? [`IT admin invite sent to: ${input.itAdminEmails.join(', ')}`]
      : []),
    '',
    'What happens next:',
    '1. Admins create credentials and sign in to the setup dashboard',
    '2. Firm-level setup: email authorization, client import, AI settings',
    '3. The whole team is invited to log in to Capiro',
    '',
    'Questions? Contact support@capiro.ai.',
  ].join('\n');

  return { subject: `Your Capiro workspace is ready — ${input.orgName}`, html, text };
}

// ---------------------------------------------------------------------------
// Receipt / billing summary (plan × method matrix)
// ---------------------------------------------------------------------------

export interface ReceiptEmailInput {
  plan: 'trial' | 'paid';
  method: 'card' | 'ach' | 'wire';
  /** Purchased client profiles (trial is fixed at MIN_CLIENT_SLOTS). */
  profiles: number;
  orgName: string;
  firstName?: string | null;
  /** Paid wire: invoice due date. */
  wireDueDate?: Date;
  /** Paid card: billing-cycle anchor (defaults to now). */
  billedAt?: Date;
  /** Paid wire: Stripe hosted invoice URL when available. */
  hostedInvoiceUrl?: string | null;
}

const METHOD_ON_FILE: Record<'card' | 'ach' | 'wire', string> = {
  card: 'Card on file — first charged on day 31.',
  ach: 'ACH (bank debit) on file — first debited on day 31; ACH takes 1–3 business days to clear.',
  wire: 'Billed by wire — if your trial converts on day 31, wire instructions and an invoice are emailed to you.',
};

export function renderReceiptEmail(input: ReceiptEmailInput): RenderedEmail {
  const profiles = Math.max(MIN_CLIENT_SLOTS, input.profiles);
  const monthly = monthlySlotCostUsd(profiles);
  const perSlot = pricePerSlotUsd(profiles);
  const priceLine = `${profiles} client profiles × ${usd(perSlot)}/profile = ${usd(monthly)}/month`;
  const greeting = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : 'Hello,';
  const org = escapeHtml(input.orgName);

  if (input.plan === 'trial') {
    const html = layout(
      heading('Trial billing summary') +
        para(greeting) +
        para(`Here is the billing summary for <b>${org}</b>'s 30-day free Capiro trial.`) +
        infoBox(
          `<b>${usd(0)} charged today.</b><br/>` +
            `Your trial begins when your firm finishes setting up its workspace, and converts to a paid subscription on <b>day 31</b> unless you cancel.<br/>` +
            `Amount due at conversion: <b>${usd(monthly)}/month</b> (${escapeHtml(priceLine)}).<br/>` +
            escapeHtml(METHOD_ON_FILE[input.method]),
        ) +
        para('Cancel any time before day 31 and nothing is billed.'),
    );
    const text = [
      greeting.replace(/&#39;/g, "'"),
      '',
      `Trial billing summary for ${input.orgName}:`,
      '$0 charged today.',
      'Your trial begins when your firm finishes setting up its workspace, and converts to a paid subscription on day 31 unless you cancel.',
      `Amount due at conversion: ${usd(monthly)}/month (${priceLine}).`,
      METHOD_ON_FILE[input.method],
      '',
      'Cancel any time before day 31 and nothing is billed.',
    ].join('\n');
    return { subject: `Your Capiro trial — ${usd(0)} charged today`, html, text };
  }

  if (input.method === 'card') {
    const billedAt = input.billedAt ?? new Date();
    const html = layout(
      heading('Receipt — payment confirmed') +
        para(greeting) +
        para(`Thank you — your Capiro subscription for <b>${org}</b> is active.`) +
        infoBox(
          `<b>${usd(monthly)} charged</b> on ${escapeHtml(formatDate(billedAt))}.<br/>` +
            `${escapeHtml(priceLine)}.<br/>` +
            `Your billing cycle starts ${escapeHtml(formatDate(billedAt))} and renews monthly.`,
        ),
    );
    const text = [
      greeting.replace(/&#39;/g, "'"),
      '',
      `Receipt for ${input.orgName}:`,
      `${usd(monthly)} charged on ${formatDate(billedAt)}.`,
      `${priceLine}.`,
      `Your billing cycle starts ${formatDate(billedAt)} and renews monthly.`,
    ].join('\n');
    return {
      subject: `Receipt — ${usd(monthly)} charged for your Capiro subscription`,
      html,
      text,
    };
  }

  // Paid wire / ACH: amount due + instructions note + due date.
  const isWire = input.method === 'wire';
  const instructions = isWire
    ? 'Bank wire instructions are on your invoice. Your workspace provisions immediately; access locks if the invoice goes unpaid.'
    : 'ACH debit initiated — funds take 1–3 business days to clear. Your workspace provisions immediately.';
  const dueLine = isWire
    ? `Due by ${formatDate(input.wireDueDate ?? new Date())}.`
    : 'Payment is expected to settle within 1–3 business days.';
  const html = layout(
    heading(isWire ? 'Invoice — amount due' : 'Payment initiated') +
      para(greeting) +
      para(`Here is the billing summary for <b>${org}</b>'s Capiro subscription.`) +
      infoBox(
        `<b>Amount due: ${usd(monthly)}</b> (${escapeHtml(priceLine)}).<br/>` +
          `${escapeHtml(instructions)}<br/>` +
          escapeHtml(dueLine),
      ) +
      (isWire && input.hostedInvoiceUrl ? button(input.hostedInvoiceUrl, 'View invoice') : ''),
  );
  const text = [
    greeting.replace(/&#39;/g, "'"),
    '',
    `Billing summary for ${input.orgName}:`,
    `Amount due: ${usd(monthly)} (${priceLine}).`,
    instructions,
    dueLine,
    ...(isWire && input.hostedInvoiceUrl ? ['', `View invoice: ${input.hostedInvoiceUrl}`] : []),
  ].join('\n');
  return {
    subject: isWire
      ? `Invoice — ${usd(monthly)} due for your Capiro subscription`
      : `Payment initiated — ${usd(monthly)} via ACH`,
    html,
    text,
  };
}

// ---------------------------------------------------------------------------
// IT-admin invite (tokened single-task page; the recipient has NO account)
// ---------------------------------------------------------------------------

export function renderItAdminInviteEmail(link: string, orgName: string): RenderedEmail {
  const org = escapeHtml(orgName);
  const html = layout(
    heading('Authorize email access for your firm') +
      para(
        `<b>${org}</b> is setting up Capiro, a government-affairs intelligence platform. Before anyone at your firm can connect their inbox or calendar, an IT administrator must approve email permissions for the organization.`,
      ) +
      para('No Capiro account is needed — the secure link below opens a single-task page.') +
      button(link, 'Authorize email access') +
      para(
        `<span style="color:${MUTED};font-size:12px;">This link expires in 7 days. If you weren't expecting this, you can ignore this email or contact support@capiro.ai.</span>`,
      ),
  );
  const text = [
    `${orgName} is setting up Capiro, a government-affairs intelligence platform.`,
    'Before anyone at your firm can connect their inbox or calendar, an IT administrator must approve email permissions for the organization.',
    '',
    'No Capiro account is needed — the secure link below opens a single-task page:',
    link,
    '',
    "This link expires in 7 days. If you weren't expecting this, you can ignore this email or contact support@capiro.ai.",
  ].join('\n');
  return {
    subject: `Action required: authorize email access for ${orgName} on Capiro`,
    html,
    text,
  };
}

// ---------------------------------------------------------------------------
// Trial/lifecycle cadence (Gherkin Flow 3 + decisions Q3/Q4)
// ---------------------------------------------------------------------------

export type TrialReminderKind =
  | 'trial_d1'
  | 'trial_d15'
  | 'trial_d25'
  | 'trial_d29'
  | 'trial_ended'
  | 'backstop_nudge'
  | 'backstop_cancel'
  | 'lockout'
  | 'retention_warning';

const REMINDER_COPY: Record<
  TrialReminderKind,
  { subject: string; body: (org: string, daysLeft: number) => string }
> = {
  trial_d1: {
    subject: 'Welcome to Capiro — your 30-day trial is underway',
    body: (org) =>
      `${org}'s workspace is live and your 30-day trial clock has started. Import clients, connect email, and explore Meri — your team has full access.`,
  },
  trial_d15: {
    subject: 'Halfway through your Capiro trial — how is it going?',
    body: (org, d) =>
      `${org} has ${d} days left in the trial. If anything is in the way — imports, email, intel coverage — just reply to this email and we'll help.`,
  },
  trial_d25: {
    subject: '5 days left in your Capiro trial',
    body: (org, d) =>
      `${org}'s trial ends in ${d} days. Unless you cancel by the end of day 30, your subscription starts on day 31 using the payment method on file.`,
  },
  trial_d29: {
    subject: 'Last day of your Capiro trial',
    body: (org) =>
      `${org}'s trial ends today. If no action is taken, the payment method on file is charged (or invoiced) tomorrow and your plan becomes active. To cancel, contact support@capiro.ai before end of day.`,
  },
  trial_ended: {
    subject: 'Your Capiro trial has ended — subscription active',
    body: (org) =>
      `${org}'s 30-day trial is complete and your subscription is now active using the payment method on file. Manage your plan anytime under Settings → Billing.`,
  },
  backstop_nudge: {
    subject: 'Your Capiro workspace is waiting on setup',
    body: (org) =>
      `${org}'s workspace was created 30 days ago, but firm setup was never finished — so your trial hasn't started. Open the setup dashboard to finish (it takes about 15 minutes), or reply if you need help.`,
  },
  backstop_cancel: {
    subject: 'Your Capiro workspace was deactivated',
    body: (org) =>
      `${org}'s workspace was created 60 days ago and setup was never completed, so we deactivated it without charging the payment method on file. Data is retained for 90 days — contact support@capiro.ai to reactivate.`,
  },
  lockout: {
    subject: 'Action required — Capiro access suspended for unpaid invoice',
    body: (org) =>
      `${org}'s invoice remains unpaid past the payment window, so workspace access is suspended. Pay the open invoice (Settings → Billing → payment portal, or the wire instructions on the invoice) and access is restored automatically. Questions: support@capiro.ai.`,
  },
  retention_warning: {
    subject: 'Final notice — Capiro data deletion in 7 days',
    body: (org) =>
      `${org}'s account was canceled 83 days ago. Per the retention policy, all data is permanently deleted 90 days after cancellation — in 7 days. To restore the account or export data, contact support@capiro.ai now.`,
  },
};

export function renderTrialReminderEmail(
  kind: TrialReminderKind,
  orgName: string,
  daysLeft: number,
): RenderedEmail {
  const copy = REMINDER_COPY[kind];
  const bodyText = copy.body(orgName, daysLeft);
  const html = layout(
    heading(escapeHtml(copy.subject)) +
      para(escapeHtml(bodyText)) +
      para(
        `<span style="color:${MUTED};font-size:12px;">Sent to your firm's billing admins. Manage the plan under Settings → Billing at app.capiro.ai.</span>`,
      ),
  );
  return {
    subject: copy.subject,
    html,
    text: `${bodyText}\n\nManage the plan under Settings → Billing at app.capiro.ai.`,
  };
}

// ---------------------------------------------------------------------------
// Signed terms copy (e-signature ceremony — Flow 1.5)
// ---------------------------------------------------------------------------

export interface SignedTermsEmailInput {
  firstName?: string | null;
  orgName: string;
  signerName: string;
  signedAt: Date;
  /** Human titles of the attached signed PDFs, e.g. ["Terms of Service", …]. */
  docTitles: string[];
}

export function renderSignedTermsEmail(input: SignedTermsEmailInput): RenderedEmail {
  const greeting = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : 'Hello,';
  const org = escapeHtml(input.orgName);
  const when = formatDate(input.signedAt);
  const titlesHtml = input.docTitles.map((t) => `<b>${escapeHtml(t)}</b>`).join(' and ');
  const titlesText = input.docTitles.join(' and ');

  const html = layout(
    heading('Your signed agreements') +
      para(greeting) +
      para(
        `Attached are your countersigned copies of the ${titlesHtml} for <b>${org}</b>, ` +
          `accepted electronically on ${escapeHtml(when)}. Each PDF includes a Certificate of ` +
          `Completion with the signature and audit record — please keep them for your files.`,
      ) +
      infoBox(
        `<b>Signed by</b> ${escapeHtml(input.signerName)}<br/>` +
          `<b>Date</b> ${escapeHtml(when)}<br/>` +
          `<span style="color:${MUTED};">This electronic signature is legally binding under the ` +
          `U.S. ESIGN Act and applicable UETA.</span>`,
      ) +
      para(
        `<span style="color:${MUTED};font-size:12px;">Questions about these documents? Contact ` +
          `<a href="mailto:legal@capiro.ai" style="color:${ACCENT};">legal@capiro.ai</a>.</span>`,
      ),
  );

  const text = [
    greeting.replace(/&#39;/g, "'"),
    '',
    `Attached are your countersigned copies of the ${titlesText} for ${input.orgName}, accepted electronically on ${when}.`,
    'Each PDF includes a Certificate of Completion with the signature and audit record — please keep them for your files.',
    '',
    `Signed by: ${input.signerName}`,
    `Date: ${when}`,
    'This electronic signature is legally binding under the U.S. ESIGN Act and applicable UETA.',
    '',
    'Questions about these documents? Contact legal@capiro.ai.',
  ].join('\n');

  return { subject: `Your signed Capiro agreements — ${input.orgName}`, html, text };
}

// ---------------------------------------------------------------------------
// Internal ops/CS notifications (managed import, provisioning failure)
// ---------------------------------------------------------------------------

export function renderOpsNotificationEmail(subject: string, lines: string[]): RenderedEmail {
  const html = layout(
    heading(escapeHtml(subject)) +
      infoBox(lines.map((line) => escapeHtml(line)).join('<br/>')) +
      para(
        `<span style="color:${MUTED};font-size:12px;">Automated notification from onboard-api.</span>`,
      ),
  );
  return {
    subject: `[Capiro onboarding] ${subject}`,
    html,
    text: [subject, '', ...lines, '', 'Automated notification from onboard-api.'].join('\n'),
  };
}
