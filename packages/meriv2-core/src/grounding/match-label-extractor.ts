import type { AssertedMatchTier } from './match-label';

export interface ExtractedMatchFinding {
  tier: AssertedMatchTier;
  findingText: string;
  citationRefs: number[];
}

const TIER = '(Direct match|Conditional niche|Adjacency)';
const TIER_MAP: Readonly<Record<string, AssertedMatchTier>> = {
  'direct match': 'direct_match',
  'conditional niche': 'conditional_niche',
  adjacency: 'adjacency',
};

function refs(text: string): number[] {
  return [...new Set([...text.matchAll(/\[(\d+)]/g)].map((match) => Number(match[1])))];
}

function clean(text: string): string {
  return text.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, '').trim();
}

export function extractMatchFindings(reply: string): ExtractedMatchFinding[] {
  if (!reply.trim()) return [];
  const lines = reply.split(/\r?\n/);
  const findings: ExtractedMatchFinding[] = [];
  let heading: AssertedMatchTier | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const headingMatch = line.match(new RegExp(`^#{1,6}\\s*${TIER}\\s*:?[\\s*#-]*$`, 'i'));
    if (headingMatch) {
      heading = TIER_MAP[headingMatch[1]!.toLowerCase()]!;
      continue;
    }
    const inline = clean(line).replace(/\*\*|__/g, '').match(new RegExp(`^${TIER}\\s*[:—-]\\s*(.+)$`, 'i'));
    if (inline) {
      const findingText = inline[2]!.trim();
      findings.push({ tier: TIER_MAP[inline[1]!.toLowerCase()]!, findingText, citationRefs: refs(findingText) });
      heading = null;
      continue;
    }
    if (heading && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(raw)) {
      const findingText = clean(raw);
      findings.push({ tier: heading, findingText, citationRefs: refs(findingText) });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) heading = null;
  }
  return findings;
}
