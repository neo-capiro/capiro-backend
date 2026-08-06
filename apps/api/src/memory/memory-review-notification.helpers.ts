import type { MemoryOperation } from './memory-authorization.helpers.js';

export const MEMORY_REVIEW_NOTIFICATION_EVENTS = [
  'review_assigned',
  'review_revision_assigned',
  'review_reassigned',
  'review_changes_requested',
  'review_approved',
  'review_rejected',
] as const;

export type MemoryReviewNotificationEvent =
  (typeof MEMORY_REVIEW_NOTIFICATION_EVENTS)[number];

export interface MemoryReviewNotificationWorkflowState {
  status: string;
  assignedTo: string | null;
  requestedBy: string | null;
}

export interface MemoryReviewNotificationEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function isMemoryReviewNotificationEvent(
  value: unknown,
): value is MemoryReviewNotificationEvent {
  return MEMORY_REVIEW_NOTIFICATION_EVENTS.includes(
    value as MemoryReviewNotificationEvent,
  );
}

export function memoryReviewNotificationOperation(
  eventType: MemoryReviewNotificationEvent,
): MemoryOperation {
  return isReviewerAssignmentEvent(eventType) ? 'approve' : 'read';
}

export function memoryReviewNotificationMatchesWorkflow(
  eventType: MemoryReviewNotificationEvent,
  recipientUserId: string,
  workflow: MemoryReviewNotificationWorkflowState,
): boolean {
  if (isReviewerAssignmentEvent(eventType)) {
    return workflow.status === 'pending' && workflow.assignedTo === recipientUserId;
  }
  if (workflow.requestedBy !== recipientUserId) return false;
  if (eventType === 'review_changes_requested') {
    return workflow.status === 'changes_needed';
  }
  if (eventType === 'review_approved') return workflow.status === 'approved';
  return workflow.status === 'rejected';
}

export function memoryReviewEmailDeliveryEnabled(
  raw: string | undefined,
): boolean {
  return raw?.trim().toLowerCase() === 'enforce';
}

export function renderMemoryReviewNotificationEmail(input: {
  eventType: MemoryReviewNotificationEvent;
  title: string;
  reviewRequestId: string;
  appOrigin?: string | null;
}): MemoryReviewNotificationEmailContent {
  const title = normalizeNotificationTitle(input.title);
  const action = eventCopy(input.eventType);
  const subject = `${action.subject}: ${title}`.slice(0, 180);
  const origin = normalizeOrigin(input.appOrigin);
  // `/settings` redirects to `/settings/personal` and drops its query string.
  // Link directly to the nested Memory route so the Phase 3 inbox can consume
  // the review-request deep link reliably.
  const reviewUrl = origin
    ? `${origin}/settings/memory?review=${encodeURIComponent(input.reviewRequestId)}`
    : null;
  const escapedTitle = escapeHtml(title);
  const escapedLead = escapeHtml(action.lead);
  const button = reviewUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open Memory Review</a></p>`
    : '';
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111827;line-height:1.5">',
    '<div style="max-width:600px;margin:0 auto;padding:24px">',
    `<h2 style="margin:0 0 16px">${escapedLead}</h2>`,
    `<p><strong>${escapedTitle}</strong></p>`,
    '<p>Open Capiro to review the current workflow. Proposed memory content and reviewer feedback are intentionally not included in email.</p>',
    button,
    '<p style="color:#6b7280;font-size:12px">This is an automated Capiro governance notification.</p>',
    '</div></body></html>',
  ].join('');
  const text = [
    action.lead,
    '',
    title,
    '',
    'Open Capiro to review the current workflow. Proposed memory content and reviewer feedback are intentionally not included in email.',
    ...(reviewUrl ? ['', reviewUrl] : []),
  ].join('\n');
  return { subject, html, text };
}

export function normalizeNotificationTitle(value: unknown): string {
  if (typeof value !== 'string') return 'Memory proposal';
  const clean = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return (clean || 'Memory proposal').slice(0, 300);
}

function isReviewerAssignmentEvent(
  eventType: MemoryReviewNotificationEvent,
): boolean {
  return (
    eventType === 'review_assigned' ||
    eventType === 'review_revision_assigned' ||
    eventType === 'review_reassigned'
  );
}

function eventCopy(eventType: MemoryReviewNotificationEvent): {
  subject: string;
  lead: string;
} {
  switch (eventType) {
    case 'review_assigned':
      return {
        subject: 'Memory review assigned',
        lead: 'A memory proposal is ready for your review.',
      };
    case 'review_revision_assigned':
      return {
        subject: 'Revised memory proposal assigned',
        lead: 'A revised memory proposal is ready for your review.',
      };
    case 'review_reassigned':
      return {
        subject: 'Memory review reassigned',
        lead: 'A memory proposal has been reassigned to you.',
      };
    case 'review_changes_requested':
      return {
        subject: 'Changes requested on memory proposal',
        lead: 'Changes were requested on your memory proposal.',
      };
    case 'review_approved':
      return {
        subject: 'Memory proposal approved',
        lead: 'Your memory proposal was approved.',
      };
    case 'review_rejected':
      return {
        subject: 'Memory proposal rejected',
        lead: 'Your memory proposal was rejected.',
      };
  }
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
