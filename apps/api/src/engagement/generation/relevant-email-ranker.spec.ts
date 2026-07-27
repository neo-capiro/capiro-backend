/**
 * Relevant-email authorization + ranking (Phase 1 §3.d1, §5.3).
 *
 * Pins the EXACT weights and tie-breaks, and — more importantly — pins that
 * authorization runs BEFORE scoring. A test that only checked ordering would
 * pass even if a walled client's thread merely ranked last.
 */
import { describe, expect, test } from '@jest/globals';
import {
  EMAIL_RANK_WEIGHTS,
  MAX_THREADS_PER_RECIPIENT,
  excludeThread,
  matchedTopicTerms,
  rankRelevantEmail,
  relevanceLabel,
  scoreThread,
  threadExcerpt,
  type EmailRankRequest,
  type EmailThreadCandidate,
} from './relevant-email-ranker.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const ME = 'user-me';
const CLIENT = 'client-a';

function thread(over: Partial<EmailThreadCandidate> = {}): EmailThreadCandidate {
  return {
    id: 't1',
    subject: 'FY27 directed energy',
    snippet: 'Following up on the markup.',
    lastMessageAt: new Date('2026-07-20T00:00:00.000Z'),
    clientId: CLIENT,
    participantEmails: ['dana.reed@mail.house.gov'],
    ownerUserId: ME,
    messages: [],
    ...over,
  };
}

function req(over: Partial<EmailRankRequest> = {}): EmailRankRequest {
  return {
    clientId: CLIENT,
    recipientEmails: ['dana.reed@mail.house.gov'],
    topicTerms: [],
    scope: 'mine',
    userId: ME,
    wallAllowsClient: true,
    audience: 'external',
    now: NOW,
    ...over,
  };
}

describe('hard exclusions run before scoring', () => {
  test('ethical-wall denial excludes regardless of relevance', () => {
    // Maximally relevant thread: right client, right participant, recent.
    const t = thread();
    expect(excludeThread(t, req({ wallAllowsClient: false }))).toBe('ethical_wall_denied');
    const ranked = rankRelevantEmail([t], req({ wallAllowsClient: false }));
    expect(ranked.included).toHaveLength(0);
    expect(ranked.excluded[0]?.reason).toBe('ethical_wall_denied');
  });

  test("a different client's thread is never reusable", () => {
    const t = thread({ clientId: 'client-b' });
    expect(excludeThread(t, req())).toBe('different_client');
  });

  test("scope 'mine' excludes a colleague's mailbox", () => {
    const t = thread({ ownerUserId: 'user-colleague' });
    expect(excludeThread(t, req())).toBe('not_own_mailbox');
  });

  test("scope 'firm_shared' still requires an EXPLICIT client link + share flag", () => {
    const notShared = thread({ ownerUserId: 'user-colleague', firmShared: false });
    expect(excludeThread(notShared, req({ scope: 'firm_shared' }))).toBe('not_firm_shared');

    const shared = thread({ ownerUserId: 'user-colleague', firmShared: true });
    expect(excludeThread(shared, req({ scope: 'firm_shared' }))).toBeNull();
  });

  test("firm_shared does NOT admit a colleague's thread with no client link", () => {
    const t = thread({ ownerUserId: 'user-colleague', firmShared: true, clientId: null });
    expect(excludeThread(t, req({ scope: 'firm_shared' }))).toBe('not_firm_shared');
  });

  test('deleted / restricted threads are excluded', () => {
    expect(excludeThread(thread({ deleted: true }), req())).toBe('deleted_or_restricted');
    expect(excludeThread(thread({ restricted: true }), req())).toBe('deleted_or_restricted');
  });

  test('a thread with no participant, topic, or client link is excluded', () => {
    const t = thread({ clientId: null, participantEmails: ['someone@else.com'] });
    expect(excludeThread(t, req())).toBe('no_relationship');
  });
});

describe('exact scoring weights', () => {
  test('explicit client match, participant, recency and direction compose', () => {
    const { score, reasons } = scoreThread(
      thread({ direction: 'outbound' }),
      req({ audience: 'external' }),
    );
    expect(score).toBe(
      EMAIL_RANK_WEIGHTS.explicitClientMatch +
        EMAIL_RANK_WEIGHTS.exactRecipientParticipant +
        EMAIL_RANK_WEIGHTS.recentActivity +
        EMAIL_RANK_WEIGHTS.directionMatchesAudience,
    );
    expect(reasons.length).toBe(4);
  });

  test('shared topic term adds exactly +20', () => {
    const base = scoreThread(thread(), req()).score;
    const withTopic = scoreThread(thread(), req({ topicTerms: ['directed energy'] })).score;
    expect(withTopic - base).toBe(EMAIL_RANK_WEIGHTS.sharedTopicTerm);
  });

  test('explicit selection adds exactly +15', () => {
    const base = scoreThread(thread(), req()).score;
    const picked = scoreThread(thread({ explicitlySelected: true }), req()).score;
    expect(picked - base).toBe(EMAIL_RANK_WEIGHTS.explicitlySelected);
  });

  test('activity older than 90 days loses the recency bonus', () => {
    const stale = thread({ lastMessageAt: new Date('2026-01-01T00:00:00.000Z') });
    const { reasons } = scoreThread(stale, req());
    expect(reasons.join(' ')).not.toMatch(/Active in the last/);
  });

  test('weak inferred client association subtracts 15', () => {
    const t = thread({ clientId: null, inferredClientOnly: true });
    const { score } = scoreThread(t, req());
    // participant (+25) + recency (+10) − weak inference (15)
    expect(score).toBe(
      EMAIL_RANK_WEIGHTS.exactRecipientParticipant +
        EMAIL_RANK_WEIGHTS.recentActivity +
        EMAIL_RANK_WEIGHTS.weakInferredClient,
    );
  });

  test('closed or contradicted subtracts 20 and is surfaced, not hidden', () => {
    const closed = scoreThread(thread({ closed: true }), req());
    const open = scoreThread(thread(), req());
    expect(closed.score - open.score).toBe(EMAIL_RANK_WEIGHTS.closedOrContradicted);
    expect(closed.reasons.join(' ')).toMatch(/closed/i);
  });
});

describe('ordering, ties and caps', () => {
  test('equal scores tie-break on last activity DESC then id ASC', () => {
    const a = thread({ id: 'b-id', lastMessageAt: new Date('2026-07-20T00:00:00.000Z') });
    const b = thread({ id: 'a-id', lastMessageAt: new Date('2026-07-20T00:00:00.000Z') });
    const older = thread({ id: 'c-id', lastMessageAt: new Date('2026-07-19T00:00:00.000Z') });
    const ranked = rankRelevantEmail([older, a, b], req());
    // Same score; newest first, then id ascending among the same timestamp.
    expect(ranked.included.map((r) => r.thread.id)).toEqual(['a-id', 'b-id', 'c-id']);
  });

  test('at most five threads are included', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      thread({ id: `t-${i}`, lastMessageAt: new Date(`2026-07-${10 + i}T00:00:00.000Z`) }),
    );
    const ranked = rankRelevantEmail(many, req());
    expect(ranked.included).toHaveLength(MAX_THREADS_PER_RECIPIENT);
  });

  test('the weak tail is DROPPED, not used to pad the top-K', () => {
    // Clears authorization only via a topic hit, then loses 20 for being closed
    // and 15 for a weak inferred association → net negative.
    const weak = thread({
      id: 'weak',
      clientId: null,
      inferredClientOnly: true,
      participantEmails: [],
      closed: true,
      lastMessageAt: new Date('2020-01-01T00:00:00.000Z'),
      subject: 'directed energy',
    });
    const ranked = rankRelevantEmail([weak], req({ topicTerms: ['directed energy'] }));
    expect(ranked.included).toHaveLength(0);
    expect(ranked.excluded).toEqual([{ threadId: 'weak', reason: 'weak_tail' }]);
  });

  test('an explicitly selected thread survives the weak-tail rule', () => {
    const weak = thread({
      id: 'weak',
      clientId: null,
      inferredClientOnly: true,
      participantEmails: [],
      closed: true,
      lastMessageAt: new Date('2020-01-01T00:00:00.000Z'),
      explicitlySelected: true,
    });
    const ranked = rankRelevantEmail([weak], req());
    expect(ranked.included.map((r) => r.thread.id)).toEqual(['weak']);
  });

  test('contradictory threads are BOTH included and both flagged', () => {
    const a = thread({ id: 'a', contradicted: true });
    const b = thread({ id: 'b', contradicted: true });
    const ranked = rankRelevantEmail([a, b], req());
    expect(ranked.included).toHaveLength(2);
    expect(ranked.included.every((r) => r.contradicted)).toBe(true);
  });

  test('no relevant email yields nothing rather than a filled top-K', () => {
    const ranked = rankRelevantEmail([], req());
    expect(ranked.included).toHaveLength(0);
  });
});

describe('explainability and excerpting', () => {
  test('every included thread carries its reasons', () => {
    const ranked = rankRelevantEmail([thread()], req());
    expect(ranked.included[0]!.reasons.length).toBeGreaterThan(0);
  });

  test('relevance labels bucket the score', () => {
    expect(relevanceLabel(70)).toBe('high');
    expect(relevanceLabel(35)).toBe('medium');
    expect(relevanceLabel(10)).toBe('low');
  });

  test('topic matching ignores fragments shorter than three characters', () => {
    expect(matchedTopicTerms(thread(), ['fy'])).toEqual([]);
    expect(matchedTopicTerms(thread(), ['FY27'])).toEqual(['FY27']);
  });

  test('excerpts are bounded and label a closed thread', () => {
    const t = thread({
      closed: true,
      messages: [
        {
          fromName: 'Dana',
          fromEmail: 'dana.reed@mail.house.gov',
          sentAt: new Date('2026-07-20T00:00:00.000Z'),
          bodyText: 'x'.repeat(5000),
        },
        {
          fromName: 'Uma',
          fromEmail: 'uma@firm.com',
          sentAt: new Date('2026-07-19T00:00:00.000Z'),
          bodyText: 'y'.repeat(5000),
        },
        {
          fromName: 'Third',
          fromEmail: 'third@firm.com',
          sentAt: new Date('2026-07-18T00:00:00.000Z'),
          bodyText: 'z'.repeat(5000),
        },
      ],
    });
    const excerpt = threadExcerpt(t);
    expect(excerpt.length).toBeLessThanOrEqual(1200);
    expect(excerpt).toMatch(/CLOSED/);
    // At most two messages are excerpted, so the third never appears.
    expect(excerpt).not.toMatch(/Third/);
  });
});
