/** One parser for persisted node citations, shared by Meri and Watch. */
export const FACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function factCitations(nodes: Array<{ id?: string | null; title?: unknown; provenance?: unknown }>) {
  const citations: Array<{ factId: string; nodeId: string | null; nodeTitle: string }> = [];
  for (const node of nodes) {
    const sources = (node.provenance as { sources?: unknown } | null)?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      const match = typeof source?.ref === 'string' ? /^fact:(.+)$/.exec(source.ref) : null;
      if (match) citations.push({ factId: match[1]!, nodeId: node.id ?? null, nodeTitle: String(node.title ?? '') });
    }
  }
  return citations;
}
