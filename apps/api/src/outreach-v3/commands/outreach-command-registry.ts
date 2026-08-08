import type { z } from 'zod';
import {
  OUTREACH_COMMAND_PAYLOAD_SCHEMAS,
  OUTREACH_COMMAND_TYPES,
  OUTREACH_FUTURE_COMMAND_TYPES,
  type OutreachCommandType,
} from '../state/outreach-command.contract.js';

export type OutreachCommandPhaseOwner = 'campaign_state' | 'target_context' | 'generation_send';
export type OutreachCommandImplementationStatus = 'implemented' | 'future';

export interface OutreachCommandRegistryEntry {
  type: OutreachCommandType;
  schemaVersion: 1;
  phaseOwner: OutreachCommandPhaseOwner;
  status: OutreachCommandImplementationStatus;
  payloadSchema: z.ZodTypeAny;
}

const TARGET_CONTEXT_COMMANDS = new Set<OutreachCommandType>([
  'ADD_TARGET_REFS',
  'REMOVE_TARGET_REFS',
  'REJECT_TARGET_RECOMMENDATION',
  'ACCEPT_CONTEXT_REFS',
  'EXCLUDE_CONTEXT_REFS',
]);

const FUTURE_COMMANDS = new Set<OutreachCommandType>(OUTREACH_FUTURE_COMMAND_TYPES);

export const OUTREACH_COMMAND_REGISTRY: readonly OutreachCommandRegistryEntry[] = Object.freeze(
  OUTREACH_COMMAND_TYPES.map((type) => ({
    type,
    schemaVersion: 1 as const,
    phaseOwner: FUTURE_COMMANDS.has(type)
      ? TARGET_CONTEXT_COMMANDS.has(type)
        ? ('target_context' as const)
        : ('generation_send' as const)
      : ('campaign_state' as const),
    status: FUTURE_COMMANDS.has(type) ? ('future' as const) : ('implemented' as const),
    payloadSchema: OUTREACH_COMMAND_PAYLOAD_SCHEMAS[type],
  })),
);

export function assertOutreachCommandRegistry(): void {
  const seen = new Set<string>();
  for (const entry of OUTREACH_COMMAND_REGISTRY) {
    if (seen.has(entry.type)) throw new Error(`Duplicate Outreach command type: ${entry.type}`);
    seen.add(entry.type);
    if (entry.schemaVersion !== 1) throw new Error(`Unsupported schema version for ${entry.type}`);
    if (entry.status === 'implemented' && entry.phaseOwner !== 'campaign_state') {
      throw new Error(`Implemented Phase 2 command has an invalid owner: ${entry.type}`);
    }
    if (entry.type.includes('SEND_EMAIL_NOW')) {
      throw new Error('External-action command types are prohibited from the Phase 2 registry.');
    }
  }
  if (seen.size !== OUTREACH_COMMAND_TYPES.length) {
    throw new Error('Outreach command registry does not exactly cover the frozen command catalog.');
  }
}

assertOutreachCommandRegistry();

export function getOutreachCommandRegistryEntry(type: OutreachCommandType) {
  const entry = OUTREACH_COMMAND_REGISTRY.find((candidate) => candidate.type === type);
  if (!entry) throw new Error(`Unknown Outreach command: ${type}`);
  return entry;
}
