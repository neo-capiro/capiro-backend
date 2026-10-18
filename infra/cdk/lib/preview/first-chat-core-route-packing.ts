/**
 * Deterministic packing of exact Meri tool names into ALB path regex values.
 *
 * ALB allows 128 characters per path pattern and three patterns per
 * condition. Names are sorted, grouped greedily, and each group is written as
 * one anchored alternation with shared prefixes factored through a character
 * trie, so a value matches exactly the names it was built from and nothing else.
 * Tool names are restricted to [a-z][a-z0-9_]*, so no regex escaping is needed.
 */
export const TOOL_PATH_PREFIX = '^/api/clio/tools/(';
export const TOOL_PATH_SUFFIX = ')$';
export const ALB_PATTERN_MAX = 128;

interface TrieNode {
  end: boolean;
  next: Map<string, TrieNode>;
}

function trie(words: readonly string[]): TrieNode {
  const root: TrieNode = { end: false, next: new Map() };
  for (const word of words) {
    let node = root;
    for (const ch of word) {
      let child = node.next.get(ch);
      if (!child) {
        child = { end: false, next: new Map() };
        node.next.set(ch, child);
      }
      node = child;
    }
    node.end = true;
  }
  return root;
}

/** Alternatives below `node`, each with single-child chains collapsed. */
function alternatives(node: TrieNode): string[] {
  return [...node.next.keys()].sort().map((ch) => {
    let label = ch;
    let child = node.next.get(ch)!;
    while (!child.end && child.next.size === 1) {
      const [nextCh, nextNode] = [...child.next.entries()][0]!;
      label += nextCh;
      child = nextNode;
    }
    return label + suffix(child);
  });
}

function suffix(node: TrieNode): string {
  if (node.next.size === 0) return '';
  const parts = alternatives(node);
  const body = parts.length === 1 ? parts[0]! : `(${parts.join('|')})`;
  if (!node.end) return body;
  return parts.length === 1 ? `(${body})?` : `${body}?`;
}

export function toolPathPattern(names: readonly string[]): string {
  return TOOL_PATH_PREFIX + alternatives(trie(names)).join('|') + TOOL_PATH_SUFFIX;
}

export function packToolPathPatterns(names: readonly string[]): string[][] {
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new Error(`Invalid tool name ${name}`);
  }
  const sorted = [...new Set(names)].sort();
  const values: string[] = [];
  let group: string[] = [];
  for (const name of sorted) {
    const trial = [...group, name];
    if (toolPathPattern(trial).length <= ALB_PATTERN_MAX) {
      group = trial;
      continue;
    }
    if (group.length === 0) throw new Error(`Tool name ${name} cannot fit one ALB pattern`);
    values.push(toolPathPattern(group));
    group = [name];
  }
  if (group.length) values.push(toolPathPattern(group));
  const rules: string[][] = [];
  for (let index = 0; index < values.length; index += 3) rules.push(values.slice(index, index + 3));
  return rules;
}
