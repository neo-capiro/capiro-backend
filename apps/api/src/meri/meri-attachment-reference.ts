import type { AttachmentContentState } from './meri-attachment-content-state.js';

export interface AttachmentReferenceCandidate {
  id: string;
  filename: string;
  turn: number | string;
  uploadedAt: Date | string;
  state: AttachmentContentState;
}

export type AttachmentReferenceResolution =
  | { kind: 'unique'; id: string }
  | { kind: 'ambiguous'; candidates: AttachmentReferenceCandidate[] }
  | { kind: 'none' };

function stem(value: string): string {
  const filename = value.trim();
  const dot = filename.lastIndexOf('.');
  return (dot > 0 ? filename.slice(0, dot) : filename).toLocaleLowerCase();
}

export function resolveAttachmentReference(reference: string, candidates: AttachmentReferenceCandidate[],
  preferLatest = false): AttachmentReferenceResolution {
  const exact = candidates.filter(candidate => candidate.filename === reference);
  const insensitive = exact.length ? exact : candidates.filter(
    candidate => candidate.filename.toLocaleLowerCase() === reference.toLocaleLowerCase());
  const matches = insensitive.length ? insensitive : candidates.filter(
    candidate => stem(candidate.filename) === stem(reference));
  if (!matches.length) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'unique', id: matches[0]!.id };
  if (preferLatest) {
    const latest = [...matches].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0]!;
    return { kind: 'unique', id: latest.id };
  }
  return { kind: 'ambiguous', candidates: matches };
}