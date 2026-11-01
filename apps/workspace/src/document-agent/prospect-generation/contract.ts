import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import {
  parseWorkspaceProspectGenerationSource,
  type WorkspaceProspectGenerationSource,
} from '@capiro/shared/workspace-prospect-generation-source';
import type {
  NativeGenerationTurnRequest,
  NativeGenerationTurnOutcome,
} from '../native-generation.bridge.js';

export const PROSPECT_GENERATION = 'prospect_generation';
export const generationHash = (value: unknown) =>
  createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');
export const generationConflict = (reason: string): never => {
  throw new ConflictException({ code: `WORKSPACE_GENERATION_${reason}` });
};
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;

export interface ProspectGenerationInput {
  requestId: string;
  expectedProspectId: string;
  expectedStateHash: string;
  sourceVersionId: string;
  sourceSnapshotHash: string;
  selectedSections: string[];
  writingBrief: string;
  paidGeneration: true;
}
export function generationInput(value: unknown): ProspectGenerationInput {
  const v = record(value);
  if (
    Object.keys(v).sort().join() !==
      'expectedProspectId,expectedStateHash,paidGeneration,requestId,selectedSections,sourceSnapshotHash,sourceVersionId,writingBrief' ||
    !['requestId', 'expectedProspectId', 'sourceVersionId'].every(
      (k) => typeof v[k] === 'string' && uuid.test(v[k] as string),
    ) ||
    !['expectedStateHash', 'sourceSnapshotHash'].every(
      (k) => typeof v[k] === 'string' && sha.test(v[k] as string),
    ) ||
    v.paidGeneration !== true ||
    typeof v.writingBrief !== 'string' ||
    !v.writingBrief.trim() ||
    Buffer.byteLength(v.writingBrief) > 4000 ||
    !Array.isArray(v.selectedSections) ||
    !v.selectedSections.length ||
    v.selectedSections.length > 100 ||
    v.selectedSections.some((n) => typeof n !== 'string' || !n.trim() || n.length > 300) ||
    new Set(v.selectedSections).size !== v.selectedSections.length
  )
    throw new BadRequestException('Select saved sources and provide a bounded writing brief');
  return structuredClone(v) as unknown as ProspectGenerationInput;
}

export interface ProspectGeneratedOutput {
  title: string;
  names: string[];
  sections: Record<string, string>;
}
export interface ProspectGenerationPayload {
  schemaVersion: 1;
  input: ProspectGenerationInput;
  requestHash: string;
  source: WorkspaceProspectGenerationSource;
  turn: NativeGenerationTurnRequest;
  outline: Array<{ id: string; name: string }>;
  title: string;
  phase: 'prepared' | 'unknown' | 'ready' | 'failed' | 'approval-required';
  runId?: string;
  nativeProposalId?: string;
  failureReason?: 'output-invalid';
  output?: ProspectGeneratedOutput;
  outputHash?: string;
  decision?: {
    requestId: string;
    actorId: string;
    decision: 'accept' | 'reject';
    requestHash: string;
  };
}
export function generationPayload(raw: unknown): ProspectGenerationPayload {
  const value = record(raw);
  try {
    generationInput(value.input);
    parseWorkspaceProspectGenerationSource(value.source);
  } catch {
    return generationConflict('RECEIPT_CONFLICT');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.requestHash !== 'string' ||
    !sha.test(value.requestHash) ||
    !['prepared', 'unknown', 'ready', 'failed', 'approval-required'].includes(
      String(value.phase),
    ) ||
    record(value.source).requestId !== record(value.turn).requestId ||
    !Array.isArray(value.outline) ||
    value.outline.length < 1 ||
    value.outline.length > 100 ||
    value.outline.some(
      (section, index) =>
        record(section).id !== `section-${index + 1}` ||
        typeof record(section).name !== 'string' ||
        !String(record(section).name).trim(),
    ) ||
    new Set(value.outline.map((section) => record(section).name)).size !== value.outline.length ||
    typeof value.title !== 'string' ||
    !value.title.trim()
  )
    return generationConflict('RECEIPT_CONFLICT');
  return value as unknown as ProspectGenerationPayload;
}

/** Narrow model output before it can become a reviewable proposal. */
export function admitProspectOutcome(
  payload: ProspectGenerationPayload,
  outcome: NativeGenerationTurnOutcome | null,
): ProspectGenerationPayload {
  if (!outcome || outcome.status === 'unknown') return { ...payload, phase: 'unknown' };
  const invalid = (): ProspectGenerationPayload => ({
    ...payload,
    phase: 'failed',
    failureReason: 'output-invalid',
  });
  if (!uuid.test(outcome.runId)) return invalid();
  if (outcome.status === 'failed') return { ...payload, phase: 'failed', runId: outcome.runId };
  if (outcome.status === 'approval_required')
    return uuid.test(outcome.proposalId)
      ? {
          ...payload,
          phase: 'approval-required',
          runId: outcome.runId,
          nativeProposalId: outcome.proposalId,
        }
      : invalid();
  const result = record(outcome.result),
    document = record(result.document),
    sections = document.sections;
  if (
    Object.keys(result).join() !== 'document' ||
    Object.keys(document).join() !== 'sections' ||
    !Array.isArray(sections) ||
    sections.length !== payload.outline.length ||
    Buffer.byteLength(JSON.stringify(sections)) > 400000 ||
    sections.some((raw, index) => {
      const section = record(raw);
      return (
        Object.keys(section).sort().join() !== 'id,text' ||
        section.id !== payload.outline[index]?.id ||
        typeof section.text !== 'string' ||
        section.text.length > 100000
      );
    })
  )
    return { ...invalid(), runId: outcome.runId };
  const output = {
    title: payload.title,
    names: payload.outline.map((s) => s.name),
    sections: Object.fromEntries(
      payload.outline.map((s, index) => [s.name, record(sections[index]).text as string]),
    ),
  };
  return {
    ...payload,
    phase: 'ready',
    runId: outcome.runId,
    output,
    outputHash: generationHash(output),
  };
}

export interface ProspectGenerationDecision {
  requestId: string;
  decision: 'accept' | 'reject';
  expectedStateHash: string;
  outputHash: string;
}
export function generationDecision(raw: unknown): ProspectGenerationDecision {
  const v = record(raw);
  if (
    Object.keys(v).sort().join() !== 'decision,expectedStateHash,outputHash,requestId' ||
    typeof v.requestId !== 'string' ||
    !uuid.test(v.requestId) ||
    !['accept', 'reject'].includes(String(v.decision)) ||
    !['expectedStateHash', 'outputHash'].every(
      (k) => typeof v[k] === 'string' && sha.test(v[k] as string),
    )
  )
    throw new BadRequestException('Invalid prospect proposal decision');
  return v as unknown as ProspectGenerationDecision;
}
