const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
/** Private research artifact, separate from the hearing preparation contract. */
export function researchWorkspace(prefill: {
  context: Record<string, unknown>;
  sources: unknown[];
}) {
  const context = prefill.context,
    citations = Array.isArray(context.citations)
      ? (context.citations as Array<Record<string, unknown>>)
      : [];
  const sections = [
    'Capiro research analysis',
    'Selected source evidence',
    'Source basis and review',
  ];
  const sectionContent = {
    [sections[0]!]: `<p>${escape(context.analysis).replace(/\n/g, '</p><p>')}</p>`,
    [sections[1]!]: citations
      .map(
        (c, i) =>
          `<p>[${i + 1}] ${escape(c.quote)}</p><p>${escape(c.documentId)} · ${escape(c.locator)} · ${escape(c.sourceUrl)}</p>`,
      )
      .join(''),
    [sections[2]!]: `<p>Editable Capiro analysis for review. Exact selected source versions are retained; this is not an official legal record.</p><p>Created ${escape(context.generatedAt)}. Review source freshness and client implications before selecting this version for a report.</p>`,
  };
  return {
    config: {
      legiwatch: {
        mode: 'research',
        snapshotId: context.snapshotId,
        contentHash: context.contentHash,
      },
      sources: prefill.sources,
      sections,
      sectionContent,
      sectionMeta: Object.fromEntries(sections.map((s) => [s, { status: 'review' }])),
    },
    contextItem: {
      kind: 'free-text' as const,
      payload: {
        text: JSON.stringify(context),
        sourceType: 'internal',
        source: 'legiwatch-research',
        snapshotId: context.snapshotId,
        contentHash: context.contentHash,
      },
    },
  };
}
