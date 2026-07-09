/**
 * Rule-resolution -> target-bill linkage parsers (LegiWatch A2). Pure + tested.
 *
 * A House "special rule" (an hres) provides for the consideration of one or
 * more measures. Its adoption/failure is the real gate on whether those
 * measures reach the floor — but Congress.gov records the rule's fate on the
 * RULE resolution, not the target bill, and the target's own action timeline
 * stops at "Rules Committee Resolution H. Res. NNNN Reported to House". These
 * two parsers recover the linkage from either side so a rule's outcome can be
 * reflected on the target bill (the exact H.R. 8800 / H.Res. 1398 gap).
 */
import { parseBillDesignation, formatBillId } from '@capiro/shared';

/** A rule hres title starts with this once it provides for consideration. */
export function isRuleResolutionTitle(title: string | null | undefined): boolean {
  return /^\s*providing for consideration of/i.test(title ?? '');
}

/**
 * Extract the canonical bill ids a rule resolution provides consideration for,
 * from its title. The title enumerates each measure in parentheses, e.g.
 * "...consideration of the bill (H.R. 8800)...; ...the resolution (H. Res. 1383)...".
 * Deduped; non-bill parentheticals are ignored (parseBillDesignation returns null).
 */
export function parseRuleTargets(title: string | null | undefined, congress: number): string[] {
  const out = new Set<string>();
  const t = title ?? '';
  for (const m of t.matchAll(/\(([^)]+)\)/g)) {
    const inner = m[1];
    if (!inner) continue;
    const parsed = parseBillDesignation(inner, congress);
    if (!parsed) continue;
    const id = formatBillId(parsed.congress, parsed.type, parsed.number);
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * Recover the rule hres id from a TARGET bill's action text, e.g.
 * "Rules Committee Resolution H. Res. 1398 Reported to House." -> "119-hres-1398".
 * Null when the action isn't a rule-report line.
 */
export function parseRuleFromBillAction(
  actionText: string | null | undefined,
  congress: number,
): string | null {
  const m = (actionText ?? '').match(/Rules Committee Resolution\s+(H\.?\s?Res\.?\s?\d+)/i);
  if (!m?.[1]) return null;
  const parsed = parseBillDesignation(m[1], congress);
  if (!parsed) return null;
  return formatBillId(parsed.congress, parsed.type, parsed.number);
}
