import type { ComparisonLine, ResearchVersion } from '@capiro/shared';

type Version = Omit<ResearchVersion, 'sections'> & { title?: string };
export function orderedBillTexts(versions: Version[]) {
  return versions.filter((v) => v.complete && v.kind === 'text').slice().sort((a, b) =>
    (a.publishedDate ?? '9999').localeCompare(b.publishedDate ?? '9999') || a.id.localeCompare(b.id));
}
export function billTextLabel(v: Version) {
  const substitute = /\/BillText\/c(\d+)\//i.exec(v.sourceUrl ?? '');
  const title = /^comm sub$/i.test(v.title ?? '')
    ? `Committee substitute${substitute ? ` ${substitute[1]}` : ''}` : v.title ?? 'Bill text';
  return `${title} · ${v.publishedDate?.slice(0, 10) ?? 'Publication date not stated'}`;
}
const furniture = (text: string) => /^(?:Page \d+ of \d+|(?:CS\/)*(?:HB|SB)\s+\d+\s+20\d{2}|[hs]b\d+-\d+-c\d+|CODING: Words stricken are deletions; words underlined are additions\.)$/i.test(text.trim())
  || /^(?:FLORIDAHOUSEOFREPRESENTATIVES|FLORIDASENATE)$/.test(text.replace(/\s/g, ''));

/** Reading aid only. Raw lines and original locators remain available unchanged. */
export function readingBillChanges(changes: ComparisonLine[]) {
  const floridaLayout = changes.some((l) => /^(?:CS\/)*(?:HB|SB)\s+\d+\s+20\d{2}$/.test(l.text.trim()));
  const side = (which: 'left' | 'right') => {
    const rows = changes.filter((l) => l[which] != null);
    const cleaned = rows.filter((l) => !(floridaLayout && furniture(l.text)));
    const numbered = new Set<number>();
    // Require three consecutive printed line counters in the same PDF page.
    // An isolated amount, section number, or year is never stripped.
    if (floridaLayout) for (let i = 0; i + 2 < cleaned.length; i++) {
      const trio = cleaned.slice(i, i + 3);
      const nums = trio.map((l) => /\s(\d{1,4})$/.exec(l.text));
      if (nums.every(Boolean) && trio.every((l) => l[which]?.locator === trio[0]![which]?.locator)
        && Number(nums[1]![1]) === Number(nums[0]![1]) + 1
        && Number(nums[2]![1]) === Number(nums[1]![1]) + 1) {
        numbered.add(i); numbered.add(i + 1); numbered.add(i + 2);
      }
    }
    return cleaned.map((line, i) => ({ ...line, comparisonKey: (numbered.has(i) ? line.text.replace(/\s\d{1,4}$/, '') : line.text).trim() }));
  };
  const left = side('left'), right = side('right');
  if (left.length * right.length > 4_000_000) return { changes: changes.filter((l) => l.kind !== 'unchanged'), numericChanges: [] as ComparisonLine[], normalized: false };
  const width = right.length + 1, dp = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
    dp[i * width + j] = left[i]!.comparisonKey === right[j]!.comparisonKey ? 1 + dp[(i + 1) * width + j + 1]!
      : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
  const result: ComparisonLine[] = [];
  const numericChanges: ComparisonLine[] = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i]!.comparisonKey === right[j]!.comparisonKey) {
      // Printed counters and legal numbers cannot be distinguished from text
      // alone. Group these changes for review; never discard their original values.
      if (left[i]!.text.trim() !== right[j]!.text.trim()) {
        numericChanges.push({ ...left[i]!, kind: 'removed', right: null }, { ...right[j]!, kind: 'added', left: null });
      }
      i++; j++;
    }
    else if (i < left.length && (j === right.length || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) {
      result.push({ ...left[i++]!, kind: 'removed', right: null });
    } else result.push({ ...right[j++]!, kind: 'added', left: null });
  }
  return { changes: result, numericChanges, normalized: floridaLayout };
}
