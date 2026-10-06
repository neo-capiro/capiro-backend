/** Office formats a Stage 2 deliverable job can produce (Release C). */
export type MeriDeliverableFormat = 'docx' | 'xlsx' | 'pptx';

export const MERI_DELIVERABLE_LABEL: Record<MeriDeliverableFormat, string> = {
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint deck',
};

export function isMeriDeliverableFormat(value: unknown): value is MeriDeliverableFormat {
  return value === 'docx' || value === 'xlsx' || value === 'pptx';
}

const WORD = /\b(word|docx|memo)\b/;
const EXCEL = /\b(excel|xlsx|spreadsheet|workbook)\b/;
const DECK = /\b(powerpoint|pptx|deck|slides)\b/;

/**
 * The file a delegated request asks for. Word unless the wording names a
 * workbook or a deck and nothing else; an explicit Word request, or wording
 * that names both a workbook and a deck, stays Word.
 */
export function deliverableFormatFor(request: string): MeriDeliverableFormat {
  const text = request.toLowerCase();
  if (WORD.test(text)) return 'docx';
  const excel = EXCEL.test(text);
  const deck = DECK.test(text);
  if (excel === deck) return 'docx';
  return excel ? 'xlsx' : 'pptx';
}
