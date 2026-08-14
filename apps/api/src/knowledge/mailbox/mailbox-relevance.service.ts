import { Injectable } from '@nestjs/common';
import type {
  MailboxMessageRecord,
  MailboxRelevanceResult,
  NormalizedMailboxMessage,
} from './mailbox-knowledge.types.js';

const GOVERNMENT_TERMS = [
  'appropriation',
  'authorization',
  'bill',
  'committee',
  'congress',
  'contract',
  'department of defense',
  'dod',
  'federal',
  'grant',
  'hearing',
  'house',
  'ndaa',
  'program element',
  'regulation',
  'rfp',
  'senate',
  'solicitation',
  'staffer',
] as const;
const RELATIONSHIP_TERMS = [
  'connect you',
  'follow up',
  'introduction',
  'introduce',
  'meet with',
  'met with',
  'spoke with',
  'thank you for meeting',
] as const;
const NEWSLETTER_MARKERS = [
  'manage preferences',
  'unsubscribe',
  'view in browser',
  'view this email in your browser',
] as const;
const MARKETING_MARKERS = [
  'book a demo',
  'buy now',
  'discount',
  'limited time',
  'register now',
  'sale ends',
  'special offer',
] as const;
const ADMINISTRATIVE_MARKERS = [
  'calendar invitation',
  'delivery status notification',
  'invoice attached',
  'password reset',
  'receipt for',
  'verification code',
] as const;
const SPAM_MARKERS = [
  'casino bonus',
  'claim your prize',
  'crypto giveaway',
  'guaranteed investment return',
] as const;
const AUTOMATED_LOCAL_PARTS = /^(?:do-?not-?reply|no-?reply|notifications?|mailer-daemon|automated|alerts?)$/i;

/**
 * Cheap deterministic gate before any model work. It favors recall for client
 * and government mail, but blocks obvious newsletters, marketing, spam, and
 * empty snippets from becoming institutional knowledge.
 */
@Injectable()
export class MailboxRelevanceService {
  classify(
    message: MailboxMessageRecord,
    normalized: NormalizedMailboxMessage,
  ): MailboxRelevanceResult {
    const corpus = `${normalized.subject}\n${normalized.normalizedText}`.toLowerCase();
    const governmentTerms = collectTerms(corpus, GOVERNMENT_TERMS);
    const relationshipTerms = collectTerms(corpus, RELATIONSHIP_TERMS);
    const newsletterMarkers = collectTerms(corpus, NEWSLETTER_MARKERS);
    const marketingMarkers = collectTerms(corpus, MARKETING_MARKERS);
    const administrativeMarkers = collectTerms(corpus, ADMINISTRATIVE_MARKERS);
    const spamMarkers = collectTerms(corpus, SPAM_MARKERS);
    const localPart = normalized.sender?.email.split('@')[0] ?? '';
    const automatedSender = AUTOMATED_LOCAL_PARTS.test(localPart);
    const clientLinked = Boolean(message.clientId);
    const substantiveLength = normalized.normalizedText.length;

    const buildResult = (
      category: MailboxRelevanceResult['category'],
      eligible: boolean,
      score: number,
      reasons: string[],
    ): MailboxRelevanceResult => ({
      category,
      eligible,
      score,
      reasons,
      signals: {
        clientLinked,
        governmentTerms,
        relationshipTerms,
        automatedSender,
        newsletterMarkers,
        marketingMarkers,
      },
    });

    if (substantiveLength < 40) {
      return buildResult('insufficient_content', false, 0.05, [
        'normalized body is under 40 characters',
      ]);
    }
    if (spamMarkers.length > 0) {
      return buildResult(
        'spam',
        false,
        0,
        spamMarkers.map((marker) => `spam marker: ${marker}`),
      );
    }

    // These opt-out/commercial markers outrank subject-matter keywords. A
    // newsletter about Congress is still a newsletter, not client-authored
    // institutional knowledge.
    if (newsletterMarkers.length > 0) {
      return buildResult(
        'newsletter',
        false,
        0.08,
        newsletterMarkers.map((marker) => `newsletter marker: ${marker}`),
      );
    }
    if (marketingMarkers.length > 0) {
      return buildResult(
        'marketing',
        false,
        0.06,
        marketingMarkers.map((marker) => `marketing marker: ${marker}`),
      );
    }
    if (administrativeMarkers.length > 0 && !clientLinked) {
      return buildResult(
        'administrative',
        false,
        0.2,
        administrativeMarkers.map((marker) => `administrative marker: ${marker}`),
      );
    }

    // Government/client content can be useful even when it comes from an alert
    // sender. Generic automated mail remains out below.
    if (governmentTerms.length >= 1 && (clientLinked || governmentTerms.length >= 2)) {
      const reasons = governmentTerms.map((term) => `government term: ${term}`);
      if (clientLinked) reasons.push('message is associated with a client');
      return buildResult(
        'government_relevant',
        true,
        clamp(0.68 + governmentTerms.length * 0.05 + (clientLinked ? 0.12 : 0)),
        reasons,
      );
    }
    if (automatedSender) {
      return buildResult('automated', false, 0.1, ['sender is an automated mailbox']);
    }
    if (relationshipTerms.length > 0) {
      const reasons = relationshipTerms.map((term) => `relationship term: ${term}`);
      if (clientLinked) reasons.push('message is associated with a client');
      return buildResult(
        'relationship_relevant',
        true,
        clamp(0.66 + relationshipTerms.length * 0.06 + (clientLinked ? 0.1 : 0)),
        reasons,
      );
    }
    if (clientLinked) {
      return buildResult('client_relevant', true, 0.78, [
        'message is associated with a client',
      ]);
    }

    const externalParticipants = [
      normalized.sender,
      ...normalized.toRecipients,
      ...normalized.ccRecipients,
    ].filter(Boolean).length;
    if (substantiveLength >= 180 && externalParticipants >= 2) {
      return buildResult(
        'business_relevant',
        true,
        0.58,
        ['substantive multi-party business correspondence'],
      );
    }

    return buildResult('personal', false, 0.25, [
      'not client-linked and no government, relationship, or business signal',
    ]);
  }
}

function collectTerms(corpus: string, terms: readonly string[]): string[] {
  return terms.filter((term) => corpus.includes(term));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
