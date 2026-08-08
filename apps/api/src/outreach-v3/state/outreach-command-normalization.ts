import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  compareCanonicalStrings,
  type TargetCriteriaV1,
} from './outreach-campaign-spec.v1.js';
import type {
  ApplyOutreachCommandBatchInput,
  ParsedOutreachCommandEnvelope,
} from './outreach-command.contract.js';

function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length ? normalized : null;
}

function normalizeSet(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    compareCanonicalStrings,
  );
}

function normalizeCriteria(value: TargetCriteriaV1 | null): TargetCriteriaV1 | null {
  if (!value) return null;
  return {
    ...value,
    notes: normalizeText(value.notes),
    governmentLevels: [...new Set(value.governmentLevels)].sort(compareCanonicalStrings),
    chambers: [...new Set(value.chambers)].sort(compareCanonicalStrings),
    committees: normalizeSet(value.committees),
    agencies: normalizeSet(value.agencies),
    states: normalizeSet(value.states),
  };
}

export function normalizeOutreachCommandEnvelope(
  command: ParsedOutreachCommandEnvelope,
): ParsedOutreachCommandEnvelope {
  const payload = command.payload as Record<string, unknown>;
  switch (command.type) {
    case 'SET_GOAL':
    case 'SET_OBJECTIVE':
    case 'SET_TOPIC':
    case 'SET_DESIRED_OUTCOME':
    case 'SET_WHY_NOW':
    case 'SET_CAMPAIGN_ANGLE':
    case 'SET_TONE':
      return { ...command, payload: { value: normalizeText(payload.value as string | null) } };
    case 'SET_ASK':
      return {
        ...command,
        payload: {
          mode: payload.mode,
          text: payload.mode === 'none' ? null : normalizeText(payload.text as string | null),
        },
      };
    case 'CLEAR_ASK':
      return { ...command, payload: {} };
    case 'SET_SPONSOR_SCOPE': {
      const refs = (payload.clientRefs as Array<{ clientId: string }>) ?? [];
      return {
        ...command,
        payload: {
          kind: payload.kind,
          label: normalizeText(payload.label as string | null),
          clientRefs: [...refs]
            .sort((a, b) => compareCanonicalStrings(a.clientId, b.clientId))
            .filter(
              (ref, index, array) => index === 0 || ref.clientId !== array[index - 1]?.clientId,
            ),
        },
      };
    }
    case 'SET_TARGET_CRITERIA':
      return {
        ...command,
        payload: { value: normalizeCriteria(payload.value as TargetCriteriaV1 | null) },
      };
    case 'SET_DELIVERY_PATTERN':
    case 'SET_PERSONALIZATION':
      return { ...command, payload: { value: payload.value } };
    case 'SET_LENGTH':
      return {
        ...command,
        payload: {
          value: payload.value,
          customInstruction:
            payload.value === 'custom'
              ? normalizeText(payload.customInstruction as string | null)
              : null,
        },
      };
    case 'RESTORE_STATE_VERSION':
      return { ...command, payload: { version: payload.version } };
    case 'ADD_TARGET_REFS':
    case 'REMOVE_TARGET_REFS':
    case 'ACCEPT_CONTEXT_REFS':
    case 'EXCLUDE_CONTEXT_REFS':
    case 'SET_ATTACHMENT_REFS':
      return {
        ...command,
        payload: { refs: normalizeSet((payload.refs as string[]) ?? []) },
      };
    case 'REJECT_TARGET_RECOMMENDATION':
      return {
        ...command,
        payload: { recommendationRef: String(payload.recommendationRef ?? '').trim() },
      };
    case 'SET_SENDER_REF':
      return { ...command, payload: { senderRef: String(payload.senderRef ?? '').trim() } };
    case 'REQUEST_SAMPLE_GENERATION':
    case 'REQUEST_FULL_GENERATION':
    case 'REQUEST_SEND_REVIEW':
      return { ...command, payload: {} };
  }
}

export function normalizeOutreachCommandBatch(
  batch: ApplyOutreachCommandBatchInput,
): ApplyOutreachCommandBatchInput {
  return {
    batchId: batch.batchId,
    expectedStateVersion: batch.expectedStateVersion,
    commands: batch.commands.map(normalizeOutreachCommandEnvelope),
  };
}

export function hashNormalizedOutreachCommandBatch(
  batch: ApplyOutreachCommandBatchInput,
): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(normalizeOutreachCommandBatch(batch)), 'utf8')
    .digest('hex');
}

export function hashNormalizedOutreachCommands(
  commands: ParsedOutreachCommandEnvelope[],
): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(commands.map(normalizeOutreachCommandEnvelope)), 'utf8')
    .digest('hex');
}
