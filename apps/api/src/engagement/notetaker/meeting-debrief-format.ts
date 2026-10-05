export function formatDebriefBody(draft: {
  recap: string;
  actionItems: string[];
  notes: string;
}): string {
  return [
    'Recap',
    draft.recap.trim() || 'No recap saved.',
    '',
    'Action Items',
    ...(draft.actionItems.length
      ? draft.actionItems.map((item) => `- ${item}`)
      : ['No action items saved.']),
    '',
    'Notes',
    draft.notes.trim() || 'No notes saved.',
  ].join('\n');
}
