type BriefPrefill = { context: Record<string, unknown>; sources: unknown[] };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => (value == null ? '' : String(value));
const escape = (value: unknown) =>
  text(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const paragraph = (value: unknown) => `<p>${escape(value)}</p>`;
const link = (label: unknown, url: unknown) => {
  try {
    const parsed = new URL(text(url));
    if (['https:', 'http:'].includes(parsed.protocol))
      return `<a href="${escape(parsed.href)}">${escape(label)}</a>`;
  } catch {
    /* Render an unlinked label. */
  }
  return escape(label);
};

/** Workspace shares sectionContent, never its config or context items. Only
 * public facts enter the initial document; permitted folder notes remain
 * separate grounding for the owner and authorized document collaborators. */
export function preparationWorkspace(prefill: BriefPrefill) {
  const context = prefill.context,
    event = object(context.event);
  const agenda = list(context.agenda).sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
  );
  const bills = list(context.bills),
    documents = list(context.documents);
  const sections = [
    'Published schedule',
    'Ordered agenda',
    'Current bill facts',
    'Sources and limitations',
  ];
  const sectionContent: Record<string, string> = {
    [sections[0]!]:
      paragraph(event.title) +
      paragraph(
        [event.committeeName, event.jurisdiction, event.session].filter(Boolean).join(' · '),
      ) +
      paragraph(
        [event.date, event.time || 'Time unconfirmed', event.timezone, event.location]
          .filter(Boolean)
          .join(' · '),
      ) +
      paragraph(
        `Published status: ${text(event.status) || 'unconfirmed'} · Calendar revision: ${text(event.revision)}`,
      ) +
      paragraph(
        `Prepared ${text(context.generatedAt)}. This preparation does not establish that testimony occurred.`,
      ),
    [sections[1]!]: agenda.length
      ? `<ol>${agenda.map((item) => `<li>${link(item.title, item.sourceUrl)}${item.kind === 'unresolved_bill' ? ' — Bill reference awaiting resolution' : ''}</li>`).join('')}</ol>`
      : paragraph('No ordered agenda is available. Check the original notice.'),
    [sections[2]!]: bills.length
      ? bills
          .map(
            (bill) =>
              `<h3>${link([bill.number, bill.title].filter(Boolean).join(' — '), bill.sourceUrl)}</h3>` +
              paragraph(
                [bill.jurisdiction, bill.sessionKey, bill.status].filter(Boolean).join(' · '),
              ) +
              paragraph(bill.summary || 'Summary unavailable.') +
              paragraph(`Source checked: ${text(bill.sourceCheckedAt) || 'Unknown'}`),
          )
          .join('')
      : paragraph('No resolved bill facts are available.'),
    [sections[3]!]:
      `<p>${link('Original event notice', event.sourceUrl)}</p>` +
      documents
        .map(
          (document) =>
            `<p>${link(document.title, document.url)}</p>` +
            (Array.isArray(document.deadlines) ? document.deadlines.map(paragraph).join('') : ''),
        )
        .join('') +
      (Array.isArray(context.limitations) ? context.limitations.map(paragraph).join('') : '') +
      paragraph(
        'Review this draft before sharing. Private folder context is attached separately for preparation.',
      ),
  };
  const folderContext = list(context.folderContext);
  return {
    config: {
      legiwatch: {
        mode: 'preparation',
        snapshotId: context.snapshotId,
        contentHash: context.contentHash,
      },
      sources: prefill.sources,
      sections,
      sectionContent,
      sectionMeta: Object.fromEntries(sections.map((section) => [section, { status: 'review' }])),
    },
    contextItem: {
      kind: 'free-text' as const,
      payload: {
        text: `LegiWatch preparation snapshot ${text(context.snapshotId)}, revision ${text(event.revision)}.\nPublished facts: ${JSON.stringify({ event, agenda, bills, documents })}\nPermitted private folder context (internal grounding, do not quote in external output without review): ${JSON.stringify(folderContext)}`,
        sourceType: 'internal',
        source: 'legiwatch-preparation',
        snapshotId: context.snapshotId,
        contentHash: context.contentHash,
        calendarRevision: event.revision,
      },
    },
  };
}
