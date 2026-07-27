/**
 * Relevant-email authorization and ranking (Phase 1 §3.d1).
 *
 * PURE functions — no I/O, no `this` — so the exact weights and tie-breaks are
 * unit-assertable without a Nest context or a database.
 *
 * Two separate jobs, in this order, and the order matters:
 *
 *   1. HARD EXCLUSIONS decide what a user is ALLOWED to see. They run first and
 *      they are not scores: no amount of topical relevance can promote a thread
 *      from another client, a walled client, or a colleague's mailbox into this
 *      draft. A score-based "penalty" for an authorization problem would mean a
 *      sufficiently on-topic thread could still leak.
 *   2. SCORING decides what is USEFUL among the threads that survived, and it is
 *      fully explainable: every included thread carries the reasons and the
 *      arithmetic, because "why is my private correspondence in this draft" must
 *      have an answer the user can read.
 *
 * The weak-tail rule is deliberate: when nothing scores, we return NOTHING rather
 * than filling a top-K with the least-irrelevant threads. Padding context with
 * weak matches is how a draft ends up "grounded" in an unrelated conversation.
 */

import type { EmailContextScope } from './evidence-packet.types.js';

/** Exact scoring weights (§3.d1). Exported so tests assert the values, not a copy. */
export const EMAIL_RANK_WEIGHTS = {
  /** The thread carries an explicit clientId equal to the campaign's client. */
  explicitClientMatch: 30,
  /** A participant address exactly equals a selected recipient/office address. */
  exactRecipientParticipant: 25,
  /** The thread mentions a selected bill / PE / issue term. */
  sharedTopicTerm: 20,
  /** The user explicitly selected or starred this thread. */
  explicitlySelected: 15,
  /** Last activity within 90 days. */
  recentActivity: 10,
  /** Communication direction matches the current audience. */
  directionMatchesAudience: 5,
  /** Only a weak INFERRED client association (no explicit clientId). */
  weakInferredClient: -15,
  /** Thread is closed, or contradicted by a newer thread. */
  closedOrContradicted: -20,
} as const;

/** Activity within this window earns the recency bonus. */
export const RECENT_ACTIVITY_DAYS = 90;

/** Caps (§3.d1). */
export const MAX_THREADS_PER_RECIPIENT = 5;
export const MAX_EXCERPTS_PER_THREAD = 2;
export const MAX_EXCERPT_CHARS_PER_THREAD = 1_200;

/**
 * Score at or below which a thread is treated as weak tail and DROPPED rather
 * than used to pad the top-K. A thread with no positive signal at all scores 0
 * or less; anything that clears this had at least one real reason.
 */
export const MIN_INCLUDABLE_SCORE = 1;

/** One candidate thread, already loaded and normalized by the caller. */
export interface EmailThreadCandidate {
  id: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: Date | string | null;
  /** The thread's EXPLICIT clientId, or null when there is none. */
  clientId: string | null;
  /**
   * True when the thread's association to the client is INFERRED (e.g. by
   * participant-domain heuristics) rather than explicitly recorded.
   */
  inferredClientOnly?: boolean;
  /** Lowercased participant addresses. */
  participantEmails: string[];
  /** The user id that owns the mail connection this thread synced through. */
  ownerUserId: string | null;
  /** True when the thread is explicitly shared firm-wide for this client. */
  firmShared?: boolean;
  /** Soft-deleted / restricted by retention or policy. */
  deleted?: boolean;
  restricted?: boolean;
  /** Thread is marked closed/resolved. */
  closed?: boolean;
  /** A newer thread contradicts this one (both are kept, both flagged). */
  contradicted?: boolean;
  /** The user explicitly selected (or starred) this thread. */
  explicitlySelected?: boolean;
  /** 'inbound' | 'outbound' | 'mixed' | null */
  direction?: 'inbound' | 'outbound' | 'mixed' | null;
  /** Bounded per-message excerpts, newest first. */
  messages?: Array<{
    fromName: string | null;
    fromEmail: string | null;
    sentAt: Date | string | null;
    bodyText: string | null;
  }>;
}

/** What the ranker is ranking against. */
export interface EmailRankRequest {
  /** The campaign's client, when there is one. */
  clientId: string | null;
  /** Lowercased addresses of the selected recipients / target offices. */
  recipientEmails: string[];
  /** Lowercased bill ids / PE codes / issue terms from the selected evidence. */
  topicTerms: string[];
  /** Resolved mailbox scope. Never taken from the browser. */
  scope: EmailContextScope;
  /** The authenticated user. */
  userId: string;
  /** False when the ethical wall denies this user access to the client. */
  wallAllowsClient: boolean;
  /** 'external' = writing to a congressional/agency contact; 'internal' = to the client. */
  audience: 'external' | 'internal';
  /** "Now", supplied so ranking is deterministic in tests. */
  now: Date;
}

export type EmailExclusionReason =
  | 'different_client'
  | 'ethical_wall_denied'
  | 'not_own_mailbox'
  | 'not_firm_shared'
  | 'deleted_or_restricted'
  | 'no_relationship'
  | 'weak_tail';

export interface RankedEmailThread {
  thread: EmailThreadCandidate;
  score: number;
  reasons: string[];
  /** True when the thread is closed or contradicted — surfaced, not hidden. */
  closed: boolean;
  contradicted: boolean;
}

export interface EmailRankResult {
  included: RankedEmailThread[];
  excluded: Array<{ threadId: string; reason: EmailExclusionReason }>;
}

/**
 * HARD exclusions. Returns the reason a thread may not be used, or null.
 *
 * Runs BEFORE scoring, and every branch is an authorization or integrity
 * decision rather than a relevance one.
 */
export function excludeThread(
  t: EmailThreadCandidate,
  req: EmailRankRequest,
): EmailExclusionReason | null {
  // Ethical wall first: when the wall denies the client, nothing about the
  // client's correspondence may be read — and the caller must not reveal titles.
  if (!req.wallAllowsClient) return 'ethical_wall_denied';

  if (t.deleted || t.restricted) return 'deleted_or_restricted';

  // A thread explicitly belonging to a DIFFERENT client is never reusable.
  if (req.clientId && t.clientId && t.clientId !== req.clientId) return 'different_client';

  if (req.scope === 'mine') {
    if (t.ownerUserId !== req.userId) return 'not_own_mailbox';
  } else {
    // firm_shared: a colleague's thread must be EXPLICITLY client-linked and
    // firm-shared. Tenant visibility in the database is not authorization —
    // broadening on "it's in our tenant" is the exact overreach §3.d2 forbids.
    const ownedByCaller = t.ownerUserId === req.userId;
    if (!ownedByCaller && !(t.firmShared && t.clientId && t.clientId === req.clientId)) {
      return 'not_firm_shared';
    }
  }

  // Must have SOME relationship: a participant, a topic, or the client link.
  const hasParticipant = t.participantEmails.some((e) => req.recipientEmails.includes(e));
  const hasClientLink = Boolean(req.clientId && t.clientId === req.clientId);
  const hasTopic = matchedTopicTerms(t, req.topicTerms).length > 0;
  if (!hasParticipant && !hasClientLink && !hasTopic && !t.explicitlySelected) {
    return 'no_relationship';
  }

  return null;
}

/** Which of the requested topic terms actually appear in this thread's text. */
export function matchedTopicTerms(t: EmailThreadCandidate, terms: string[]): string[] {
  if (!terms.length) return [];
  const haystack = [t.subject ?? '', t.snippet ?? '', ...(t.messages ?? []).map((m) => m.bodyText ?? '')]
    .join(' ')
    .toLowerCase();
  const hits: string[] = [];
  for (const term of terms) {
    const needle = term.trim().toLowerCase();
    if (needle.length >= 3 && haystack.includes(needle)) hits.push(term);
  }
  return hits;
}

/** Score one thread and record WHY. Assumes exclusions already passed. */
export function scoreThread(
  t: EmailThreadCandidate,
  req: EmailRankRequest,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const w = EMAIL_RANK_WEIGHTS;

  if (req.clientId && t.clientId === req.clientId) {
    score += w.explicitClientMatch;
    reasons.push(`Explicitly filed under this client (+${w.explicitClientMatch})`);
  }

  const matchedParticipants = t.participantEmails.filter((e) => req.recipientEmails.includes(e));
  if (matchedParticipants.length) {
    score += w.exactRecipientParticipant;
    reasons.push(
      `A selected recipient is on this thread: ${matchedParticipants.join(', ')} (+${w.exactRecipientParticipant})`,
    );
  }

  const topics = matchedTopicTerms(t, req.topicTerms);
  if (topics.length) {
    score += w.sharedTopicTerm;
    reasons.push(`Mentions selected topic(s): ${topics.join(', ')} (+${w.sharedTopicTerm})`);
  }

  if (t.explicitlySelected) {
    score += w.explicitlySelected;
    reasons.push(`You selected this thread (+${w.explicitlySelected})`);
  }

  const lastAt = toDate(t.lastMessageAt);
  if (lastAt) {
    const days = (req.now.getTime() - lastAt.getTime()) / 86_400_000;
    if (days <= RECENT_ACTIVITY_DAYS) {
      score += w.recentActivity;
      reasons.push(
        `Active in the last ${RECENT_ACTIVITY_DAYS} days (${Math.max(0, Math.round(days))}d ago) (+${w.recentActivity})`,
      );
    }
  }

  // Direction match: writing OUT to a congressional/agency contact is informed
  // most by our own outbound history; an internal client update is informed by
  // what the client sent us.
  const wantedDirection = req.audience === 'external' ? 'outbound' : 'inbound';
  if (t.direction === wantedDirection || t.direction === 'mixed') {
    score += w.directionMatchesAudience;
    reasons.push(`Direction matches this audience (+${w.directionMatchesAudience})`);
  }

  if (t.inferredClientOnly && !(req.clientId && t.clientId === req.clientId)) {
    score += w.weakInferredClient;
    reasons.push(`Only a weak inferred client association (${w.weakInferredClient})`);
  }

  if (t.closed || t.contradicted) {
    score += w.closedOrContradicted;
    reasons.push(
      t.contradicted
        ? `Contradicted by a newer thread (${w.closedOrContradicted})`
        : `Thread is closed (${w.closedOrContradicted})`,
    );
  }

  return { score, reasons };
}

/**
 * Authorize, score, sort, and cap.
 *
 * Sort: score DESC, then last activity DESC, then id ASC. The last two are what
 * make an equal-score tie deterministic — without them two identical requests
 * could produce different packets and the packet hash would be meaningless.
 */
export function rankRelevantEmail(
  candidates: EmailThreadCandidate[],
  req: EmailRankRequest,
  limit = MAX_THREADS_PER_RECIPIENT,
): EmailRankResult {
  const excluded: EmailRankResult['excluded'] = [];
  const scored: RankedEmailThread[] = [];

  for (const t of candidates) {
    const reason = excludeThread(t, req);
    if (reason) {
      excluded.push({ threadId: t.id, reason });
      continue;
    }
    const { score, reasons } = scoreThread(t, req);
    // Weak tail: an explicitly selected thread is ALWAYS kept (the user asked
    // for it, and it stays labeled), but an auto-suggested thread that cleared
    // authorization on a technicality and scored nothing is dropped.
    if (score < MIN_INCLUDABLE_SCORE && !t.explicitlySelected) {
      excluded.push({ threadId: t.id, reason: 'weak_tail' });
      continue;
    }
    scored.push({
      thread: t,
      score,
      reasons,
      closed: Boolean(t.closed),
      contradicted: Boolean(t.contradicted),
    });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aAt = toDate(a.thread.lastMessageAt)?.getTime() ?? 0;
    const bAt = toDate(b.thread.lastMessageAt)?.getTime() ?? 0;
    if (aAt !== bAt) return bAt - aAt;
    return a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0;
  });

  const included = scored.slice(0, limit);
  for (const dropped of scored.slice(limit)) {
    excluded.push({ threadId: dropped.thread.id, reason: 'weak_tail' });
  }
  return { included, excluded };
}

/** Score → the coarse label shown in the UI. */
export function relevanceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 55) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

/**
 * Bounded excerpt text for one thread: at most MAX_EXCERPTS_PER_THREAD messages
 * and MAX_EXCERPT_CHARS_PER_THREAD characters total. This text is
 * external_untrusted evidence — the caller MUST spotlight it.
 */
export function threadExcerpt(t: EmailThreadCandidate): string {
  const lines: string[] = [];
  const header = [
    t.subject ? `Subject: ${t.subject}` : null,
    toDate(t.lastMessageAt) ? `Last activity: ${toDate(t.lastMessageAt)!.toISOString().slice(0, 10)}` : null,
    t.closed ? 'Status: CLOSED' : null,
    t.contradicted ? 'Status: CONTRADICTED by a newer thread' : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(' | ');
  if (header) lines.push(header);

  const messages = (t.messages ?? []).slice(0, MAX_EXCERPTS_PER_THREAD);
  if (messages.length) {
    for (const m of messages) {
      const who = m.fromName || m.fromEmail || 'unknown';
      const when = toDate(m.sentAt)?.toISOString().slice(0, 10) ?? '';
      const body = (m.bodyText ?? '').replace(/\s+/g, ' ').trim();
      lines.push(`- ${who}${when ? ` @ ${when}` : ''}: ${body}`);
    }
  } else if (t.snippet) {
    lines.push(`- ${t.snippet.replace(/\s+/g, ' ').trim()}`);
  }

  const joined = lines.join('\n');
  return joined.length > MAX_EXCERPT_CHARS_PER_THREAD
    ? `${joined.slice(0, MAX_EXCERPT_CHARS_PER_THREAD - 1).trim()}…`
    : joined;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
