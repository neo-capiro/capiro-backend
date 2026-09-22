import type { ClaimLedger } from '../assurance/claim-ledger';
import type { MaterialClaim } from './claim-inventory';

export type DocumentContentState =
  | 'ready'
  | 'partial'
  | 'metadata_only'
  | 'failed'
  | 'pending'
  | 'unsupported'
  | 'indexed_or_extracted';

export interface DocumentReference {
  kind: 'attachment' | 'client_document';
  id: string;
  filename: string;
  version: string | null;
  contentState: DocumentContentState;
  readable: boolean;
  relevantPassageIds: string[];
  resolution: 'explicit_id' | 'filename' | 'pronoun_heuristic';
  clientId?: string | null;
  requestedVersion?: string | null;
  requestedClientId?: string | null;
}

export interface DocumentReferenceCandidate {
  id: string;
  filename: string;
  version?: string | null;
  contentState?: DocumentContentState;
  readable?: boolean;
  relevantPassageIds?: readonly string[];
  clientId?: string | null;
}

export interface ResolveDocumentReferencesInput {
  userText: string;
  selectedAttachmentIds: readonly string[];
  priorTurnManifest: readonly DocumentReferenceCandidate[];
  clientDocuments: readonly DocumentReferenceCandidate[];
  clientId?: string | null;
}

export type ExactSourceEligibilityReason =
  | 'ok'
  | 'no_document'
  | 'unreadable'
  | 'metadata_only'
  | 'no_relevant_passage'
  | 'version_mismatch'
  | 'wrong_client';

export interface ExactSourceEligibility {
  eligible: boolean;
  reason: ExactSourceEligibilityReason;
}

/**
 * Resolves already-known references only. Filename and pronoun matches are
 * explicitly heuristic and this function never reads or retrieves a document.
 */
export function resolveDocumentReferences(input: ResolveDocumentReferencesInput): DocumentReference[] {
  const text = input.userText.toLowerCase();
  const selected = new Set(input.selectedAttachmentIds);
  const candidates = [
    ...input.priorTurnManifest.map((candidate) => ({ ...candidate, kind: 'attachment' as const })),
    ...input.clientDocuments.map((candidate) => ({ ...candidate, kind: 'client_document' as const })),
  ];
  const output: DocumentReference[] = [];
  for (const candidate of candidates) {
    let resolution: DocumentReference['resolution'] | undefined;
    if (selected.has(candidate.id) || mentionsId(input.userText, candidate.id)) resolution = 'explicit_id';
    else if (mentionsFilename(text, candidate.filename)) resolution = 'filename';
    else if (candidates.length === 1 && /\b(?:it|this|that|the)\s+(?:file|document|attachment|transcript|memo|report)\b/i.test(input.userText)) {
      resolution = 'pronoun_heuristic';
    }
    if (!resolution) continue;
    output.push({
      kind: candidate.kind,
      id: candidate.id,
      filename: candidate.filename,
      version: candidate.version ?? null,
      contentState: candidate.contentState ?? 'metadata_only',
      readable: candidate.readable === true && readableState(candidate.contentState),
      relevantPassageIds: orderedUnique(candidate.relevantPassageIds ?? []),
      resolution,
      ...(candidate.clientId !== undefined ? { clientId: candidate.clientId } : {}),
      ...(input.clientId !== undefined ? { requestedClientId: input.clientId } : {}),
      ...parseRequestedVersion(input.userText, candidate.filename),
    });
  }
  return dedupeReferences(output);
}

/** Metadata, filenames, empty extraction, and failed reads never establish content. */
export function checkExactSourceEligibility(
  claim: MaterialClaim,
  references: readonly DocumentReference[],
  ledger?: ClaimLedger,
): ExactSourceEligibility {
  if (!isDocumentSpecificClaim(claim, ledger)) return { eligible: true, reason: 'ok' };
  const related = references.filter((reference) => referenceMatchesClaim(reference, claim, ledger));
  if (!related.length) return { eligible: false, reason: 'no_document' };
  if (related.every((reference) => reference.requestedClientId && reference.clientId !== reference.requestedClientId)) {
    return { eligible: false, reason: 'wrong_client' };
  }
  if (related.every((reference) => reference.requestedVersion && reference.version !== reference.requestedVersion)) {
    return { eligible: false, reason: 'version_mismatch' };
  }
  const scoped = related.filter(
    (reference) =>
      (!reference.requestedClientId || reference.clientId === reference.requestedClientId) &&
      (!reference.requestedVersion || reference.version === reference.requestedVersion),
  );
  if (scoped.every((reference) => reference.contentState === 'metadata_only')) {
    return { eligible: false, reason: 'metadata_only' };
  }
  if (scoped.every((reference) => !reference.readable || !readableState(reference.contentState))) {
    return { eligible: false, reason: 'unreadable' };
  }
  if (scoped.every((reference) => reference.relevantPassageIds.length === 0)) {
    return { eligible: false, reason: 'no_relevant_passage' };
  }
  return { eligible: true, reason: 'ok' };
}

export function isDocumentSpecificClaim(claim: MaterialClaim, ledger?: ClaimLedger): boolean {
  if (/\b(?:attachment|document|file|memo|report|transcript|meeting notes?|minutes|brief)\b/i.test(claim.text)) return true;
  if (claim.category === 'report_language') return true;
  const evidence = ledger?.evidence.filter((item) => claim.evidenceIds.includes(item.id)) ?? [];
  return evidence.some((item) =>
    /(?:document|attachment|transcript|client_context)/i.test(`${item.sourceType} ${item.sourceId}`),
  );
}

function referenceMatchesClaim(
  reference: DocumentReference,
  claim: MaterialClaim,
  ledger?: ClaimLedger,
): boolean {
  if (claim.evidenceIds.includes(reference.id)) return true;
  if (claim.text.toLowerCase().includes(reference.filename.toLowerCase())) return true;
  const evidence = ledger?.evidence.filter((item) => claim.evidenceIds.includes(item.id)) ?? [];
  if (evidence.some((item) => item.sourceId === reference.id || item.id === reference.id)) return true;
  return referencesCanSupplyGenericDocumentClaim(claim);
}

function referencesCanSupplyGenericDocumentClaim(claim: MaterialClaim): boolean {
  return /\b(?:attachment|document|file|memo|report|transcript|meeting notes?|minutes|brief)\b/i.test(claim.text) || claim.category === 'report_language';
}

function readableState(state: DocumentContentState | undefined): boolean {
  return state === 'ready' || state === 'partial' || state === 'indexed_or_extracted';
}

function mentionsId(text: string, id: string): boolean {
  return id.length >= 4 && text.toLowerCase().includes(id.toLowerCase());
}

function mentionsFilename(text: string, filename: string): boolean {
  const lower = filename.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, '');
  return text.includes(lower) || (stem.length >= 4 && text.includes(stem));
}

function parseRequestedVersion(text: string, filename: string): Pick<DocumentReference, 'requestedVersion'> | object {
  if (!mentionsFilename(text.toLowerCase(), filename)) return {};
  const match = text.match(/\b(?:version|v)\s*([\w.-]+)/i);
  return match ? { requestedVersion: match[1]! } : {};
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeReferences(references: readonly DocumentReference[]): DocumentReference[] {
  const byKey = new Map<string, DocumentReference>();
  for (const reference of references) {
    const key = `${reference.kind}:${reference.id}`;
    const existing = byKey.get(key);
    if (!existing || resolutionRank(reference.resolution) < resolutionRank(existing.resolution)) byKey.set(key, reference);
  }
  return [...byKey.values()];
}

function resolutionRank(resolution: DocumentReference['resolution']): number {
  return resolution === 'explicit_id' ? 0 : resolution === 'filename' ? 1 : 2;
}
