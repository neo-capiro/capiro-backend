const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const sourceLink = (value: unknown) => {
  try {
    const url = new URL(String(value));
    if (['http:', 'https:'].includes(url.protocol))
      return `<a href="${escape(url.toString())}">${escape(value)}</a>`;
  } catch {
    /* Render unsupported source values as text. */
  }
  return escape(value);
};
export function editorialCoverage(gaps: unknown, sources: unknown[]): string {
  if (!Array.isArray(gaps) || !gaps.length)
    return '<p>No additional gaps were recorded for the selected evidence. This edition does not imply complete legislative or news coverage.</p>';
  return (
    '<ul>' +
    gaps
      .map((value) => {
        const gap =
          typeof value === 'string'
            ? { reason: value }
            : ((value ?? {}) as Record<string, unknown>);
        const source = sources.find(
          (s) => s && typeof s === 'object' && (s as Record<string, unknown>).id === gap.id,
        ) as Record<string, unknown> | undefined;
        return `<li>${source?.title ? `<strong>${escape(source.title)}:</strong> ` : ''}${escape(gap.reason || 'Source coverage requires review.')}</li>`;
      })
      .join('') +
    '</ul>'
  );
}
/** Explicit maintenance only: rewrite the exact legacy generated suffix.
 * All surrounding author edits, source receipts and approved runs are untouched. */
export function formatLegacyEditorialCoverage(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  sources: unknown[],
) {
  const legiwatch = config.legiwatch as Record<string, unknown> | undefined;
  const content = config.sectionContent as Record<string, unknown> | undefined;
  const prior = content?.['Cutoff and coverage'];
  if (
    legiwatch?.mode !== 'editorial' ||
    legiwatch.snapshotId !== context.snapshotId ||
    typeof prior !== 'string'
  )
    return null;
  const suffix = `<p>${escape(JSON.stringify(context.gaps ?? []))}</p>`;
  if (!prior.endsWith(suffix)) return null;
  return {
    ...config,
    sectionContent: {
      ...content,
      'Cutoff and coverage':
        prior.slice(0, -suffix.length) + editorialCoverage(context.gaps, sources),
    },
  };
}
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
                `<blockquote>${escape(x.quote)}</blockquote><p>${escape(x.authority)} · ${escape(x.locator)} · ${sourceLink(x.sourceUrl)}</p>`,
            )
            .join(''),
      )
      .join(''),
    [sections[2]!]:
      '<p>Review the cited developments for a supported next action. No calendar item, owner or deadline is inferred from missing evidence.</p>',
    [sections[3]!]: `<p>Knowledge cutoff ${escape(c.cutoff)} (${escape(c.timezone)}). Capiro analysis for review; attributed reporting and fiscal proposals retain their source authority.</p>${editorialCoverage(c.gaps, prefill.sources)}`,
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
