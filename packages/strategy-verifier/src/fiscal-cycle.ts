import type { VerifierNode, Violation } from './types.js';

/** Annual formulation normally happens in the calendar year before the funded FY.
 * Later enactment/supplementals are possible, so these are review warnings, never retiming rules. */
export function checkFiscalCycle(
  nodes: Pick<VerifierNode, 'id' | 'title' | 'startsOn'>[],
  objective = '',
): Violation[] {
  const years = (text: string) =>
    [...text.matchAll(/\bFY\s*(20\d{2}|\d{2})\b/gi)].map((match) =>
      Number(match[1]) < 100 ? 2000 + Number(match[1]) : Number(match[1]),
    );
  const objectiveYears = [...new Set(years(objective))];
  const out: Violation[] = [];
  for (const node of nodes) {
    if (
      !/president.?s budget|member request|committee mark|\bmarkup\b|floor amendment|\bconference\b|final bills? signed|sign(?:ing)? .*?(?:appropriation|NDAA)/i.test(
        node.title,
      )
    )
      continue;
    if (/supplemental|continuing resolution|late enactment|delayed enactment/i.test(node.title))
      continue;
    const ownYears = [...new Set(years(node.title))];
    const target =
      ownYears.length === 1
        ? ownYears[0]
        : ownYears.length === 0 && objectiveYears.length === 1
          ? objectiveYears[0]
          : undefined;
    if (
      !target ||
      !/^\d{4}-\d{2}-\d{2}$/.test(node.startsOn) ||
      Number(node.startsOn.slice(0, 4)) < target
    )
      continue;
    out.push({
      code: 'calendar-cycle-review',
      severity: 'warning',
      nodeIds: [node.id],
      message: `“${node.title}” is dated ${node.startsOn} for FY${target}. The annual budget/authorization cycle normally precedes that fiscal year; confirm whether this is a delayed or supplemental action.`,
      suggestion: `Review the FY${target} source calendar (normally calendar ${target - 1}) and correct this step’s dates or identify the delayed/supplemental cycle. Do not shift dates without a source.`,
    });
  }
  return out;
}
