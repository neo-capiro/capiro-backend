/** Public document updates shared by the canonical event and hearing room. */
export const HEARING_DOCUMENT_UPDATE_TYPES = [
  'witness_testimony_published',
  'committee_memo_published',
  'amendment_added',
  'archive_posted',
  'official_transcript_posted',
];

export function mergeHearingDocuments(
  snapshot: unknown,
  updates: Array<{
    id: string;
    normalizedTitle: string;
    updateType: string;
    sourceUrl: string;
    officialPublishedAt: Date | null;
  }>,
): Array<Record<string, unknown>> {
  const calendar =
    (snapshot as { documents?: Array<Record<string, unknown>> } | null)?.documents ?? [];
  const documents = [
    ...calendar.map((d) => ({
      id: d.key,
      title: d.title,
      documentType: d.kind,
      sourceUrl: d.url,
      publishedAt: d.publishedAt ?? null,
      contentHash: d.contentHash,
      deadlines: d.deadlines,
    })),
    ...updates.map((update) => ({
      id: update.id,
      title: update.normalizedTitle,
      documentType: update.updateType,
      sourceUrl: update.sourceUrl,
      publishedAt: update.officialPublishedAt?.toISOString() ?? null,
    })),
  ];
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (typeof document.sourceUrl !== 'string' || !document.sourceUrl.trim()) return false;
    const key = document.sourceUrl.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
