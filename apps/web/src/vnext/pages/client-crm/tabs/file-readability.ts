import type { ClientAttachment } from '../../../../pages/clients/clientTypes.js';
import type { PillTone } from '../portfolio-primitives.js';

/** A legacy Indexed timestamp can mean only a filename was embedded. */
export function fileReadability(
  file: Pick<ClientAttachment, 'indexedAt' | 'extractionStatus' | 'extractionMetadata'>,
): { status: string; tone: PillTone } {
  const meta = file.extractionMetadata;
  const lastSection =
    meta?.lastSectionRead && typeof meta.lastSectionRead === 'object'
      ? (meta.lastSectionRead as Record<string, unknown>)
      : null;
  const observation = lastSection ?? meta;
  const readability =
    observation?.readability && typeof observation.readability === 'object'
      ? (observation.readability as Record<string, unknown>)
      : null;
  if (readability?.status === 'ocr_unavailable')
    return { status: 'Visual read unavailable', tone: 'warning' };
  if (readability?.status === 'ocr_partial')
    return { status: 'Visual text partial', tone: 'warning' };
  if (readability?.status === 'ocr_readable')
    return { status: 'Visual text read · page only', tone: 'warning' };
  if (observation?.sectionRead === true)
    return {
      status:
        observation.emptySection === true || readability?.status === 'no_readable_text'
          ? 'No readable text · section'
          : 'Text read · section only',
      tone: 'warning',
    };
  if (file.extractionStatus === 'failed') return { status: 'Extraction failed', tone: 'error' };
  if (file.extractionStatus === 'empty' || meta?.contentScope === 'metadata_only') {
    return {
      status: meta?.sectionRead === true ? 'No readable text · section' : 'No readable text',
      tone: 'warning',
    };
  }
  if (file.extractionStatus === 'truncated' || meta?.truncated === true)
    return { status: 'Text partially indexed', tone: 'warning' };
  if (
    file.indexedAt &&
    file.extractionStatus === 'extracted' &&
    typeof meta?.chars === 'number' &&
    meta.chars > 0
  ) {
    return { status: 'Text searchable', tone: 'success' };
  }
  return { status: file.indexedAt ? 'Readability unverified' : 'Uploaded', tone: 'gray' };
}
