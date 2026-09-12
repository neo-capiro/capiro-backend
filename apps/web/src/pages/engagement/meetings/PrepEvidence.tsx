import type { MeetingPrep } from './meetings-types.js';

export function prepContextChanged(prep: MeetingPrep, clientId: string | null): boolean {
  return (
    !!prep.generatedFrom &&
    'clientId' in prep.generatedFrom &&
    prep.generatedFrom.clientId !== clientId
  );
}

export function PrepSourceLinks({
  prep,
  section,
  itemIndex = 0,
  sourceIds: explicitSourceIds,
}: {
  prep: MeetingPrep;
  section: string;
  itemIndex?: number;
  sourceIds?: string[];
}) {
  const grounding = prep.generatedFrom?.grounding;
  // References address positions in the original generated text, so never
  // attach them to edited list items (including a subsequently approved edit).
  if (!grounding || grounding.contentEdited) return null;
  const sourceIds = new Set(
    explicitSourceIds ?? grounding.references
      .filter((ref) => ref.section === section && ref.itemIndex === itemIndex)
      .flatMap((ref) => ref.sourceIds),
  );
  return (
    <>
      {grounding.sources.map((source, index) =>
        sourceIds.has(source.id) ? (
          <a
            key={source.id}
            href={`#prep-${prep.id}-source-${index}`}
            style={{ fontSize: 11, marginLeft: 5 }}
            aria-label={`Source ${index + 1}: ${source.title}`}
          >
            [{index + 1}]
          </a>
        ) : null,
      )}
    </>
  );
}

/** Render the saved excerpt as readable field/value text while preserving its
 * wording; the model never supplies source titles, dates, or excerpts. */
export function prepSourceExcerpt(excerpt: string): string {
  try {
    const parsed = JSON.parse(excerpt);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return excerpt;
    return Object.entries(parsed)
      .filter(([key, value]) => !['id', 'clientId'].includes(key) && value != null)
      .map(
        ([key, value]) =>
          `${key.replace(/([a-z])([A-Z])/g, '$1 $2')}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
      )
      .join('\n');
  } catch {
    return excerpt;
  }
}

export function PrepEvidence({ prep, clientId }: { prep: MeetingPrep; clientId: string | null }) {
  const grounding = prep.generatedFrom?.grounding;
  if (!grounding)
    return (
      <p role="note" style={{ fontSize: 12, color: 'var(--notable)', margin: 0 }}>
        This saved prep has no source references. Review names and claims before use.
      </p>
    );
  const contextChanged = prepContextChanged(prep, clientId);
  return (
    <section aria-label="Prep sources and review notes" style={{ fontSize: 12, lineHeight: 1.6 }}>
      <p style={{ marginTop: 0 }}>
        Sources from the original generation are listed below. Source links identify supplied
        records; review whether they support each claim.
      </p>
      {grounding.contentEdited && (
        <p role="note">
          This prep was edited after generation. Source links apply to the original draft; recheck
          the edited text.
        </p>
      )}
      {contextChanged && (
        <p role="note">
          The meeting client changed after this prep was generated. These sources describe the
          previous context; regenerate for the current client.
        </p>
      )}
      {grounding.attendees.length > 0 && (
        <p>
          <strong>Attendees recorded at generation: </strong>
          {grounding.attendees.map((attendee) => attendee.name).join(', ')}
        </p>
      )}
      {grounding.limitations.length > 0 && (
        <ul aria-label="Evidence gaps">
          {grounding.limitations.map((limitation, index) => (
            <li key={index}>{limitation}</li>
          ))}
        </ul>
      )}
      {grounding.sources.length === 0 ? (
        <p>No source links were recorded. Review the prep before use.</p>
      ) : (
        <ol style={{ paddingLeft: 20 }}>
          {grounding.sources.map((source, index) => (
            <li key={source.id} id={`prep-${prep.id}-source-${index}`} style={{ marginBottom: 10 }}>
              <strong>{source.title}</strong>
              {source.observedAt ? ` · ${source.observedAt}` : ''}
              <details>
                <summary>View supplied source excerpt</summary>
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {prepSourceExcerpt(source.excerpt)}
                </p>
                {source.recordId && <small>Source record: {source.recordId}</small>}
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
