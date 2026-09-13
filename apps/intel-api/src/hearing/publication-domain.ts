import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const UNOFFICIAL_HEARING_LABEL = 'Unofficial transcript-based hearing update';
export interface HearingEvidence {
  segmentId: string;
  hash: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
}
export interface HearingClaim {
  id: string;
  kind: 'quote' | 'observation' | 'analysis';
  text: string;
  evidenceIds: string[];
}
export interface HearingPublicationPayload {
  schema: 'legiwatch.hearing-publication.v1';
  kind: 'live_update' | 'hearing_recap';
  title: string;
  label: string;
  sessionId: string;
  hearingId: string | null;
  clientId: string | null;
  jurisdiction: string | null;
  legislativeSession: string | null;
  folders: Array<{
    id: string;
    version: number;
    clientId: string | null;
    assignments?: Array<{ id: string; version: number }>;
  }>;
  bills: Array<{ id: string; number: string; jurisdiction: string; sessionKey: string }>;
  claims: HearingClaim[];
  evidence: HearingEvidence[];
  coverage: {
    transcript: string;
    audio: string;
    recordingId: string | null;
    captureId?: string;
    missing: string[];
  };
  provenance: {
    tool: string;
    promptVersion: string;
    model: string | null;
    clientContext?: 'applied' | 'unavailable' | 'none';
    folderContextHash?: string;
  };
}
export const evidenceHash = (
  value: Pick<HearingEvidence, 'segmentId' | 'text' | 'startMs' | 'endMs' | 'speakerLabel'>,
) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateHearingClaims(claims: HearingClaim[], evidence: HearingEvidence[]) {
  if (!claims.length || claims.length > 100 || evidence.length > 500)
    throw new BadRequestException('BOUNDED_CLAIMS_AND_EVIDENCE_REQUIRED');
  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (
      !claim.id ||
      claimIds.has(claim.id) ||
      !['quote', 'observation', 'analysis'].includes(claim.kind) ||
      !claim.text.trim() ||
      claim.text.length > 2500 ||
      !claim.evidenceIds.length ||
      claim.evidenceIds.length > 20
    ) {
      throw new BadRequestException('EVERY_CLAIM_REQUIRES_EXPLICIT_EVIDENCE');
    }
    claimIds.add(claim.id);
    const refs = claim.evidenceIds.map((id) => evidence.find((row) => row.segmentId === id));
    if (refs.some((row) => !row)) throw new BadRequestException('CLAIM_EVIDENCE_UNAVAILABLE');
    if (
      claim.kind === 'quote' &&
      !refs.some((row) => normalize(row!.text).includes(normalize(claim.text)))
    ) {
      throw new BadRequestException('QUOTE_MUST_MATCH_PERSISTED_TRANSCRIPT');
    }
  }
}
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
/** Jurisdiction and legislative session remain separate from a bare number. */
export function hearingBillMentions(text: string, jurisdiction: string | null) {
  const pattern =
    jurisdiction === 'FL'
      ? /\b(H\.?\s*B\.?|S\.?\s*B\.?)\s*0*(\d+)\b/gi
      : jurisdiction === 'US'
        ? /\b(H\.?\s*R\.?|S\.?)\s*0*(\d+)\b/gi
        : null;
  if (!pattern) return [];
  return [
    ...new Set(
      [...text.matchAll(pattern)].map(
        (match) => match[1]!.replace(/[.\s]/g, '').toUpperCase() + BigInt(match[2]!).toString(),
      ),
    ),
  ];
}
export function publicationMarkdown(payload: HearingPublicationPayload) {
  const lines = [
    `# ${payload.title}`,
    '',
    `**${payload.label}**`,
    '',
    'This recap or update describes recorded testimony. It is not a published legislative record.',
    '',
    `Coverage: transcript ${payload.coverage.transcript}; audio ${payload.coverage.audio}.`,
    ...payload.coverage.missing.map((item) => `Missing or uncertain: ${item}`),
    '',
  ];
  for (const claim of payload.claims) {
    lines.push(
      `${claim.kind === 'analysis' ? 'Analysis: ' : claim.kind === 'quote' ? 'Transcript quote: ' : ''}${claim.text}`,
      `Evidence: ${claim.evidenceIds
        .map((id) => {
          const row = payload.evidence.find((e) => e.segmentId === id)!;
          return `${id} (${Math.floor(row.startMs / 1000)}–${Math.ceil(row.endMs / 1000)} seconds)`;
        })
        .join('; ')}`,
      '',
    );
  }
  return lines.join('\n');
}
