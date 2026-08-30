import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  compareCanonicalStrings,
  type TargetCriteriaV1,
} from './outreach-campaign-spec.v1.js';
import {
  normalizeTargetLocatorV1,
  outreachRejectedTargetRecommendationV1Schema,
  targetKeyForLocator,
  type OutreachTargetLocatorV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import {
  contextKeyForSelection,
  normalizeContextSelectionV1,
  normalizeExcludedContextRefsV1,
  type OutreachContextSelectionV1,
} from '../../capabilities/context/outreach-context.contract.js';
import {
  normalizeStyleSampleInputV1,
  styleSampleKeyFor,
  type OutreachStyleSampleInputV1,
} from './outreach-style-sample.contract.js';
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

function normalizeTargetLocators(values: unknown[]): OutreachTargetLocatorV1[] {
  const byKey = new Map<string, OutreachTargetLocatorV1>();
  for (const value of values) {
    const locator = normalizeTargetLocatorV1(value);
    const key = targetKeyForLocator(locator);
    if (!byKey.has(key)) byKey.set(key, locator);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => compareCanonicalStrings(a, b))
    .map(([, locator]) => locator);
}

function normalizeContextSelections(values: unknown[]): OutreachContextSelectionV1[] {
  const byKey = new Map<string, OutreachContextSelectionV1>();
  for (const value of values) {
    const selection = normalizeContextSelectionV1(value);
    const key = contextKeyForSelection(selection);
    if (!byKey.has(key)) byKey.set(key, selection);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => compareCanonicalStrings(a, b))
    .map(([, selection]) => selection);
}

/**
 * Dedupe submitted exemplars by derived key while KEEPING submitted order.
 *
 * Unlike target locators and context selections (both sorted, because they are
 * order-free sets), few-shot order is read by the model and chosen by the user,
 * so sorting here would silently reorder their examples. Normalizing still makes
 * the batch hash stable, which is all `hashNormalizedOutreachCommandBatch` needs
 * for replay detection.
 */
function normalizeStyleSampleInputs(values: unknown[]): OutreachStyleSampleInputV1[] {
  const byKey = new Map<string, OutreachStyleSampleInputV1>();
  for (const value of values) {
    const sample = normalizeStyleSampleInputV1(value);
    const key = styleSampleKeyFor(sample);
    if (!byKey.has(key)) byKey.set(key, sample);
  }
  return [...byKey.values()];
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
    case 'ADD_TARGET_REFS':
      return {
        ...command,
        payload: { refs: normalizeTargetLocators((payload.refs as unknown[]) ?? []) },
      };
    case 'REMOVE_TARGET_REFS':
      return {
        ...command,
        payload: { targetKeys: normalizeSet((payload.targetKeys as string[]) ?? []) },
      };
    case 'REJECT_TARGET_RECOMMENDATION': {
      const parsed = outreachRejectedTargetRecommendationV1Schema.parse(payload);
      return { ...command, payload: parsed };
    }
    case 'SET_TARGET_CC_BCC':
      // Addresses are already lower-cased/trimmed by targetCcBccEmailSchema at
      // parse time; the only cross-batch-hash normalization left is de-duping
      // and sorting each list the same way REMOVE_TARGET_REFS's targetKeys are,
      // so two submissions that differ only in address order or duplicates
      // hash identically.
      return {
        ...command,
        payload: {
          targetKey: payload.targetKey as string,
          cc: normalizeSet((payload.cc as string[]) ?? []),
          bcc: normalizeSet((payload.bcc as string[]) ?? []),
        },
      };
    case 'ACCEPT_CONTEXT_REFS':
      return {
        ...command,
        payload: {
          selections: normalizeContextSelections((payload.selections as unknown[]) ?? []),
        },
      };
    case 'EXCLUDE_CONTEXT_REFS':
      return {
        ...command,
        payload: {
          refs: normalizeExcludedContextRefsV1((payload.refs as unknown[]) ?? []),
        },
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
    case 'ADD_STYLE_SAMPLES':
      return {
        ...command,
        payload: { samples: normalizeStyleSampleInputs((payload.samples as unknown[]) ?? []) },
      };
    case 'REMOVE_STYLE_SAMPLES':
      return {
        ...command,
        payload: { sampleKeys: normalizeSet((payload.sampleKeys as string[]) ?? []) },
      };
    case 'SET_CONTENT_SKELETON': {
      // CRLF→LF here as well as in normalizeCampaignSpecV1: the command itself is
      // hashed into the batch's idempotency identity, so the same skeleton pasted
      // from a Windows browser must not read as a different command than from a
      // Mac one — otherwise a retried submit would look like a new intent.
      const raw = payload.value as
        | {
            subject?: unknown;
            body?: unknown;
            slots?: unknown[];
          }
        | null
        | undefined;
      if (!raw) return { ...command, payload: { value: null } };
      return {
        ...command,
        payload: {
          value: {
            subject: String(raw.subject ?? '').replace(/\r\n?/g, '\n').trim(),
            body: String(raw.body ?? '').replace(/\r\n?/g, '\n').trimEnd(),
            slots: ((raw.slots as Array<Record<string, unknown>>) ?? []).map((slot) => ({
              key: String(slot.key ?? ''),
              label: String(slot.label ?? '').trim(),
              instruction: String(slot.instruction ?? '')
                .replace(/\r\n?/g, '\n')
                .trim(),
              required: Boolean(slot.required),
            })),
          },
        },
      };
    }
    case 'RESTORE_STATE_VERSION':
      return { ...command, payload: { version: payload.version } };
    case 'SET_ATTACHMENT_REFS':
      return {
        ...command,
        payload: { refs: normalizeSet((payload.refs as string[]) ?? []) },
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
