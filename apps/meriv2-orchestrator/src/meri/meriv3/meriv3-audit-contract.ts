export interface MeriChatMessageLike {
  role?: unknown;
  text?: unknown;
}

export interface LiteralAuditContext {
  active: boolean;
  priorAnswer: string | null;
  instruction: string | null;
}

export interface LiteralAuditIssue {
  code: 'missing_literal_quote' | 'quote_absent_from_prior_answer';
  excerpt: string;
  quote?: string;
}

export interface LiteralAuditValidation {
  valid: boolean;
  issues: LiteralAuditIssue[];
}

const AUDIT_REQUEST_RE =
  /\b(?:recheck|re-check|audit|fact[- ]?check|correct|reconcile|review|verify)\b/i;
const PRIOR_ANSWER_RE =
  /\b(?:answer|response|reply|you just gave|just gave|previous|prior|earlier)\b/i;

// Deliberately narrow: ordinary uses of "stated" or "changed" must not become
// retraction assertions. These patterns target only claims about Meri's own
// immediately preceding answer.
const RETRACTION_ASSERTION_RE =
  /\b(?:retract(?:ion)?|correction\s+to|change\s+from)\b|\b(?:i\s+(?:(?:previously|earlier|also)\s+)?|(?:my|the)\s+(?:prior|previous|earlier)\s+answer\s+)(?:said|stated|claimed|wrote|reported)\b/i;
const NO_CHANGE_RE = /\b(?:no\s+(?:material\s+)?change|nothing\s+to\s+retract|no\s+retraction)\b/i;
const QUOTED_TEXT_RE = /["\u201c]([^"\u201d]{4,500})["\u201d]/g;

/**
 * Return the exact preceding assistant answer only for an explicit same-chat
 * audit request. The caller may append the instruction to the model prompt;
 * normal turns remain unchanged.
 */
export function buildLiteralAuditContext(
  messages: readonly MeriChatMessageLike[],
): LiteralAuditContext {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.text === 'string') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return { active: false, priorAnswer: null, instruction: null };

  const request = String(messages[lastUserIndex]?.text ?? '').trim();
  if (!AUDIT_REQUEST_RE.test(request) || !PRIOR_ANSWER_RE.test(request)) {
    return { active: false, priorAnswer: null, instruction: null };
  }

  let priorAnswer: string | null = null;
  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && typeof message.text === 'string' && message.text.trim()) {
      priorAnswer = message.text.trim();
      break;
    }
  }
  if (!priorAnswer) return { active: false, priorAnswer: null, instruction: null };

  return {
    active: true,
    priorAnswer,
    instruction: [
      '# Literal prior-answer audit contract',
      'Audit the exact preceding assistant answer, not a reconstructed or imagined answer.',
      'For every claim you would change or retract, quote the smallest exact passage from the prior answer in double quotation marks, then give the corrected wording and its direct source.',
      'Never say the prior answer contained a claim unless the quoted passage appears literally in the prior answer below.',
      'If the requested issue was not stated in the prior answer, say that no matching prior statement was found; do not invent a retraction.',
      'Preserve useful supported text and separately identify source work that is still incomplete.',
      '',
      '<literal_prior_answer>',
      priorAnswer.replace(/<\/literal_prior_answer>/gi, '&lt;/literal_prior_answer&gt;'),
      '</literal_prior_answer>',
    ].join('\n'),
  };
}

/**
 * Fail closed on explicit retraction assertions that do not identify a literal
 * passage from the preceding answer. This does not attempt semantic fact
 * checking; it prevents the narrower M1/Q1 failure where an audit "corrects"
 * text that never appeared.
 */
export function validateLiteralAuditCorrections(
  auditReply: string,
  priorAnswer: string,
): LiteralAuditValidation {
  const issues: LiteralAuditIssue[] = [];
  const normalizedPrior = normalizeForMatch(priorAnswer);
  const segments = String(auditReply ?? '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (!RETRACTION_ASSERTION_RE.test(segment) || NO_CHANGE_RE.test(segment)) continue;
    const quotes = [...segment.matchAll(QUOTED_TEXT_RE)]
      .map((match) => match[1]?.trim() ?? '')
      .filter(Boolean);
    if (quotes.length === 0) {
      issues.push({
        code: 'missing_literal_quote',
        excerpt: segment.slice(0, 240),
      });
      continue;
    }
    for (const quote of quotes) {
      if (!normalizedPrior.includes(normalizeForMatch(quote))) {
        issues.push({
          code: 'quote_absent_from_prior_answer',
          excerpt: segment.slice(0, 240),
          quote: quote.slice(0, 200),
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

function normalizeForMatch(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
