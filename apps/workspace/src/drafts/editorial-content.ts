const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function editorialWorkspace(prefill: {
  context: Record<string, unknown>;
  sources: unknown[];
}) {
  const c = prefill.context,
    citations = Array.isArray(c.citations) ? (c.citations as Array<Record<string, unknown>>) : [];
  const layouts: Record<string, string[]> = {
    research_update: [
      'Developments and client implications',
      'Supporting records and changes',
      'Useful actions and remaining questions',
    ],
    daily_legislative_brief: [
      'Legislative developments',
      'Published records and budget changes',
      'Next scheduled work and preparation',
    ],
    morning_news_brief: [
      'Issue contents and news summary',
      'Reporting and prior-day developments',
      'Today’s preparation and outstanding questions',
    ],
  };
  const sections = [
    ...(layouts[String(c.template)] ?? layouts.research_update!),
    'Cutoff and coverage',
  ];
  const sectionContent = {
    [sections[0]!]: `<p>${escape(c.analysis).replace(/\n/g, '</p><p>')}</p>`,
    [sections[1]!]: (prefill.sources as Array<Record<string, unknown>>)
      .map(
        (source, index) =>
          `<h3>[${index + 1}] ${escape(source.title)}</h3>` +
          citations
            .filter((x) => x.id === source.id && x.kind === source.kind)
            .map(
              (x) =>
                `<blockquote>${escape(x.quote)}</blockquote><p>${escape(x.authority)} · ${escape(x.locator)} · ${escape(x.sourceUrl)}</p>`,
            )
            .join(''),
      )
      .join(''),
    [sections[2]!]:
      '<p>Review the cited developments for a supported next action. No calendar item, owner or deadline is inferred from missing evidence.</p>',
    [sections[3]!]: `<p>Knowledge cutoff ${escape(c.cutoff)} (${escape(c.timezone)}). Capiro analysis for review; attributed reporting and fiscal proposals retain their source authority.</p><p>${escape(JSON.stringify(c.gaps ?? []))}</p>`,
  };
  return {
    config: {
      legiwatch: { mode: 'editorial', snapshotId: c.snapshotId, contentHash: c.contentHash },
      sources: prefill.sources,
      sections,
      sectionContent,
      sectionMeta: Object.fromEntries(sections.map((s) => [s, { status: 'review' }])),
    },
    contextItem: {
      payload: {
        text: JSON.stringify(c),
        sourceType: 'internal',
        source: 'legiwatch-editorial',
        snapshotId: c.snapshotId,
        contentHash: c.contentHash,
      },
    },
  };
}
