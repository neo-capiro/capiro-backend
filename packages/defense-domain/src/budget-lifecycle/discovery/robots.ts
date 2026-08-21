/**
 * Phase 8 Session 8 — robots.txt evaluation for live official-source discovery.
 *
 * Session 7's discovery port was manifest-driven, so politeness was somebody
 * else's problem. A live crawler has to answer three questions before it issues
 * a single request, and each one was verified against the real hosts:
 *
 *  1. **Is this path allowed?** `www.govinfo.gov` publishes a real robots.txt
 *     that disallows `/search/` but says nothing about `/sitemap/` or
 *     `/content/pkg/`, which is exactly the channel this session crawls.
 *
 *  2. **How fast may we go?** `www.congress.gov` declares `Crawl-delay: 2`.
 *     The adapter registry independently declares a 1000 ms minimum interval for
 *     the same publisher. The publisher's number is the stricter one, and a
 *     crawler that honoured only its own registry would be twice as aggressive
 *     as the site asks. The effective interval is therefore the MAXIMUM of the
 *     two, never the registry value alone.
 *
 *  3. **Are we welcome at all?** `www.congress.gov` ends a very long
 *     `User-agent:` group naming AI crawlers with a bare `Disallow: /`. A crawler
 *     that ignored group selection, or that shipped a user agent matching one of
 *     those names, would be crawling a site that has explicitly excluded it.
 *     `assertUserAgentPermitted` refuses to run in that case rather than
 *     crawling anyway.
 *
 * Fetch-status semantics follow RFC 9309 section 2.3.1:
 *
 *   * `2xx` — parse and apply.
 *   * `4xx` — "unavailable", crawling is unrestricted. Real case:
 *     `comptroller.defense.gov` answers robots.txt with an Akamai 403.
 *   * `5xx` — RFC 9309 says a crawler MAY assume complete disallow. We do NOT,
 *     because the real observed case is `api.govinfo.gov` returning a 500 JSON
 *     application error — an app fault, not a crawl directive. Treating that as
 *     "disallow everything" would make discovery fail closed on a publisher that
 *     never expressed a restriction. The permission is granted but flagged
 *     `robotsUnavailable`, and the flag is persisted on the crawl audit row so
 *     the decision is visible rather than implicit.
 */

/** Directive kinds we honour. Everything else in the file is ignored. */
export type RobotsRuleKind = 'allow' | 'disallow';

export interface RobotsRule {
  readonly kind: RobotsRuleKind;
  /** Raw path pattern, may contain wildcards and a trailing anchor. */
  readonly pattern: string;
}

export interface RobotsGroup {
  /** Lower-cased user-agent tokens this group applies to. */
  readonly userAgents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsPolicy {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  /**
   * `true` when the publisher expressed no policy we could read (4xx/5xx or an
   * unparseable body). Recorded, never silently swallowed.
   */
  readonly unavailable: boolean;
  readonly statusCode: number | null;
}

export const ROBOTS_ALLOW_ALL: RobotsPolicy = Object.freeze({
  groups: Object.freeze([]),
  sitemaps: Object.freeze([]),
  unavailable: true,
  statusCode: null,
});

/**
 * Parse a robots.txt body. Grouping follows RFC 9309: consecutive
 * `User-agent:` lines accumulate into one group, and the group ends at the first
 * rule line followed by another `User-agent:`.
 */
export function parseRobotsTxt(body: string, statusCode: number | null = 200): RobotsPolicy {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let pendingAgents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelaySeconds: number | null = null;
  let collectingAgents = false;

  const flush = (): void => {
    if (pendingAgents.length > 0) {
      groups.push(
        Object.freeze({
          userAgents: Object.freeze([...pendingAgents]),
          rules: Object.freeze([...rules]),
          crawlDelaySeconds,
        }),
      );
    }
    pendingAgents = [];
    rules = [];
    crawlDelaySeconds = null;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    // Comments run to end of line; a line that is only a comment is skipped.
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // A `User-agent:` after rules starts a NEW group.
      if (!collectingAgents && pendingAgents.length > 0) flush();
      collectingAgents = true;
      if (value !== '') pendingAgents.push(value.toLowerCase());
      continue;
    }

    if (field === 'sitemap') {
      // Sitemap is a non-group field: it applies to the whole file.
      if (value !== '') sitemaps.push(value);
      continue;
    }

    collectingAgents = false;

    if (field === 'allow' || field === 'disallow') {
      // An empty `Disallow:` means "allow everything" and carries no pattern.
      if (field === 'disallow' && value === '') continue;
      rules.push(Object.freeze({ kind: field, pattern: value }));
      continue;
    }

    if (field === 'crawl-delay') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) crawlDelaySeconds = parsed;
    }
  }
  flush();

  return Object.freeze({
    groups: Object.freeze(groups),
    sitemaps: Object.freeze(sitemaps),
    unavailable: false,
    statusCode,
  });
}

/**
 * Build the policy for a robots.txt fetch outcome. See the header for why a 5xx
 * is treated as unavailable rather than as a complete disallow.
 */
export function robotsPolicyFromFetch(input: {
  statusCode: number | null;
  body: string | null;
}): RobotsPolicy {
  const { statusCode, body } = input;
  if (statusCode !== null && statusCode >= 200 && statusCode < 300 && typeof body === 'string') {
    return parseRobotsTxt(body, statusCode);
  }
  return Object.freeze({
    groups: Object.freeze([]),
    sitemaps: Object.freeze([]),
    unavailable: true,
    statusCode,
  });
}

/**
 * RFC 9309 group selection: the most specific matching user-agent token wins,
 * where specificity is token length. The wildcard token is the fallback and only
 * applies when no explicit token matches.
 */
export function selectRobotsGroup(policy: RobotsPolicy, userAgent: string): RobotsGroup | null {
  const needle = userAgent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | null = null;
  let wildcard: RobotsGroup | null = null;

  for (const group of policy.groups) {
    for (const token of group.userAgents) {
      if (token === '*') {
        wildcard ??= group;
        continue;
      }
      // RFC 9309 matches a product token as a substring of the crawler's UA.
      if (!needle.includes(token)) continue;
      if (!best || token.length > best.length) best = { group, length: token.length };
    }
  }

  return best?.group ?? wildcard ?? null;
}

/** Translate a robots pattern into an anchored regular expression. */
function robotsPatternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export interface RobotsDecision {
  readonly allowed: boolean;
  /** The rule that decided, for the audit trail. `null` when nothing matched. */
  readonly matchedRule: RobotsRule | null;
  readonly reason: string;
  /** Effective publisher-declared delay, when the selected group states one. */
  readonly crawlDelaySeconds: number | null;
  readonly robotsUnavailable: boolean;
}

/**
 * Longest-match wins; an Allow and a Disallow of equal length both matching is
 * resolved in favour of Allow, per RFC 9309 section 2.2.2.
 */
export function evaluateRobots(input: {
  policy: RobotsPolicy;
  userAgent: string;
  /** Path plus query, for example `/sitemap/CRPT_sitemap_index.xml`. */
  pathAndQuery: string;
}): RobotsDecision {
  const { policy, userAgent, pathAndQuery } = input;

  if (policy.unavailable) {
    return Object.freeze({
      allowed: true,
      matchedRule: null,
      reason:
        policy.statusCode === null
          ? 'robots.txt not retrieved; RFC 9309 unavailable-status semantics allow crawling'
          : `robots.txt returned HTTP ${policy.statusCode}; treated as unavailable, not as a directive`,
      crawlDelaySeconds: null,
      robotsUnavailable: true,
    });
  }

  const group = selectRobotsGroup(policy, userAgent);
  if (!group) {
    return Object.freeze({
      allowed: true,
      matchedRule: null,
      reason: 'no robots group applies to this user agent',
      crawlDelaySeconds: null,
      robotsUnavailable: false,
    });
  }

  let decision: { rule: RobotsRule; length: number } | null = null;
  for (const rule of group.rules) {
    if (!robotsPatternToRegExp(rule.pattern).test(pathAndQuery)) continue;
    const length = rule.pattern.replace(/\$$/, '').length;
    if (!decision || length > decision.length) {
      decision = { rule, length };
      continue;
    }
    // Equal specificity: Allow beats Disallow.
    if (length === decision.length && rule.kind === 'allow') decision = { rule, length };
  }

  if (!decision) {
    return Object.freeze({
      allowed: true,
      matchedRule: null,
      reason: 'no rule in the applicable group matches this path',
      crawlDelaySeconds: group.crawlDelaySeconds,
      robotsUnavailable: false,
    });
  }

  return Object.freeze({
    allowed: decision.rule.kind === 'allow',
    matchedRule: decision.rule,
    reason: `${decision.rule.kind} ${decision.rule.pattern} (longest match)`,
    crawlDelaySeconds: group.crawlDelaySeconds,
    robotsUnavailable: false,
  });
}

export class UserAgentExcludedByPublisherError extends Error {
  constructor(readonly host: string, readonly userAgent: string) {
    super(
      `Publisher ${host} excludes user agent "${userAgent}" from the entire site. ` +
        'Discovery refuses to crawl a publisher that has explicitly excluded it.',
    );
    this.name = 'UserAgentExcludedByPublisherError';
  }
}

/**
 * Refuse to crawl a host whose applicable group bans the whole site.
 *
 * This is not hypothetical: congress.gov terminates a long list of AI-crawler
 * user agents with a site-wide disallow. Selecting the wrong group, or shipping a
 * user agent that matches one of those tokens, would mean crawling a publisher
 * that said no.
 */
export function assertUserAgentPermitted(input: {
  policy: RobotsPolicy;
  userAgent: string;
  host: string;
}): void {
  const decision = evaluateRobots({
    policy: input.policy,
    userAgent: input.userAgent,
    pathAndQuery: '/',
  });
  if (!decision.allowed) {
    throw new UserAgentExcludedByPublisherError(input.host, input.userAgent);
  }
}
