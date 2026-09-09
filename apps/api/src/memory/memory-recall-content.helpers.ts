/** Describes the approved bytes without replacing them with a newer source.
 * Old learning captures can have a governed event description but no fact.
 * Keeping that distinction in the read projection preserves review history. */
export function describeMemoryRecallContent(input: {
  title: string;
  value: string;
  sourceType?: string | null;
}): {
  title: string;
  contentStatus: 'available' | 'metadata_only' | 'empty';
  contentLimitation: string | null;
} {
  const body = input.value.trim();
  const learned =
    input.sourceType === 'learning_signal_capture' || input.title.startsWith('learning-signal:');
  let event: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) event = parsed;
  } catch {
    /* A prose fact need not be JSON. */
  }
  const metadataJson =
    event &&
    typeof event.summary === 'string' &&
    /^(?:crm_finding_accepted|meri_feedback_(?:positive|negative)) on (?:crm\.fill_with_meri|meri\.chat)\b/.test(
      event.summary,
    ) &&
    // Only classify the known capture metadata shape. Additional content stays
    // readable as a possible fact until a reviewer determines otherwise.
    Object.keys(event).every((key) =>
      [
        'summary',
        'sourceKind',
        'sourceSystem',
        'proposedLayer',
        'proposedMemoryLayer',
        'proposedAuthority',
        'proposedMemoryClass',
        'proposedMemoryAuthority',
        'proposedConfidence',
        'hasNote',
        'note',
        'confidence',
        'reasons',
        'signalType',
        'sourceSurface',
      ].includes(key),
    ) &&
    (event.note === undefined ||
      event.note === 'Review the referenced evidence objects for full context before approving.');
  const eventOnly =
    learned &&
    (metadataJson ||
      /^No structured fact text was available for this signal\b/i.test(body) ||
      /^Reason code\(s\) selected on this rating:/i.test(body) ||
      /^(?:Captured learning signal|Learning signal captured|crm_finding_accepted on crm\.fill_with_meri|meri_feedback_(?:positive|negative) on meri\.chat)\b/i.test(
        body,
      ) ||
      // Original captures described the event, proposed layer and confidence.
      // Restrict detection to that template; a real fact may mention confidence.
      /^(?:CRM|Fill-with-Meri)\b[^\n]*(?:finding|signal)[^\n]*(?:accepted|captured)[^\n]*proposed layer\b/i.test(
        body,
      ));
  const contentStatus = !body ? 'empty' : eventOnly ? 'metadata_only' : 'available';
  let title = input.title;
  if (learned && input.title.startsWith('learning-signal:')) {
    const factLine = body.split(/\r?\n/, 1)[0]?.trim() ?? '';
    title =
      contentStatus === 'available' && factLine
        ? factLine.slice(0, 160)
        : 'Learning capture — source fact unavailable';
  }
  return {
    title,
    contentStatus,
    contentLimitation:
      contentStatus === 'metadata_only'
        ? 'This approved record contains a learning-event description, not the underlying fact. The original source must be reviewed before proposing corrected content; approval of this event is not verification of an unstored capability, person or facility.'
        : contentStatus === 'empty'
          ? 'This approved record has no stored section body. No source fact can be inferred from its title or approval.'
          : null,
  };
}
