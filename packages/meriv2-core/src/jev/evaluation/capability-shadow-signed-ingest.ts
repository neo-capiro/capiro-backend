import { createHash } from 'node:crypto';
import {
  buildCapabilityShadowReport,
  type CapabilityShadowEvent,
  type CapabilityShadowReport,
  type VerifiedCapabilityShadowMembership,
} from './capability-shadow';
import {
  capabilityShadowEventVerificationKeysSchema,
  capabilityShadowSignedEventSchema,
  verifyCapabilityShadowSignedEvent,
} from './capability-shadow-event-trust';

const MAX_JSON_DEPTH = 64;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_REGISTRY_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_SIGNED_CAPABILITY_SHADOW_ROWS = 2_000;

/** Check raw JSON keys before JSON.parse can silently collapse duplicates. */
export function parseCapabilityShadowUniqueJson(raw: string, maxBytes: number): unknown {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('JSON input exceeds byte limit');
  let cursor = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(raw[cursor] ?? '\0')) cursor += 1; };
  const string = (): string => {
    if (raw[cursor] !== '"') throw new Error('invalid JSON string');
    const start = cursor++;
    while (cursor < raw.length) {
      if (raw[cursor] === '"') return JSON.parse(raw.slice(start, ++cursor)) as string;
      if (raw[cursor] === '\\') cursor += 2;
      else cursor += 1;
    }
    throw new Error('unterminated JSON string');
  };
  const value = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error('JSON nesting exceeds limit');
    whitespace();
    if (raw[cursor] === '"') { string(); return; }
    if (raw[cursor] === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (raw[cursor] === '}') { cursor += 1; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate raw JSON key');
        keys.add(key);
        whitespace();
        if (raw[cursor++] !== ':') throw new Error('invalid JSON object');
        value(depth + 1);
        whitespace();
        const separator = raw[cursor++];
        if (separator === '}') return;
        if (separator !== ',') throw new Error('invalid JSON object');
      }
    }
    if (raw[cursor] === '[') {
      cursor += 1;
      whitespace();
      if (raw[cursor] === ']') { cursor += 1; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        const separator = raw[cursor++];
        if (separator === ']') return;
        if (separator !== ',') throw new Error('invalid JSON array');
      }
    }
    const start = cursor;
    while (cursor < raw.length && !/[\t\n\r ,}\]]/.test(raw[cursor]!)) cursor += 1;
    if (start === cursor) throw new Error('invalid JSON value');
  };
  value(0);
  whitespace();
  if (cursor !== raw.length) throw new Error('invalid trailing JSON');
  return JSON.parse(raw) as unknown;
}

export interface CapabilityShadowSignedIngestion {
  events: CapabilityShadowEvent[];
  sourceSha256: string;
  publicRegistrySha256: string;
  verifiedEvents: number;
}

/** Opt-in offline path. Every nonblank line must be a valid signed envelope. */
export function ingestCapabilityShadowSignedEvents(
  rawJsonl: string,
  publicRegistryJson: string,
  expectedPublicRegistrySha256: string,
): CapabilityShadowSignedIngestion {
  if (Buffer.byteLength(rawJsonl, 'utf8') > MAX_INPUT_BYTES) throw new Error('signed event input exceeds 32 MiB');
  if (!/^[a-f0-9]{64}$/i.test(expectedPublicRegistrySha256)) throw new Error('public registry SHA-256 pin is required');
  const publicRegistrySha256 = createHash('sha256').update(publicRegistryJson, 'utf8').digest('hex');
  if (publicRegistrySha256 !== expectedPublicRegistrySha256.toLowerCase()) throw new Error('public registry SHA-256 pin mismatch');
  const registry = capabilityShadowEventVerificationKeysSchema.parse(
    parseCapabilityShadowUniqueJson(publicRegistryJson, MAX_REGISTRY_BYTES),
  );
  const lines = rawJsonl.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > MAX_SIGNED_CAPABILITY_SHADOW_ROWS) throw new Error('signed event count exceeds 2000');
  if (lines.length === 0) throw new Error('signed event input is empty');
  const events: CapabilityShadowEvent[] = [];
  for (const line of lines) {
    const envelope = capabilityShadowSignedEventSchema.parse(parseCapabilityShadowUniqueJson(line, MAX_ENVELOPE_BYTES));
    verifyCapabilityShadowSignedEvent(envelope, registry);
    events.push(envelope.payload.event);
  }
  return {
    events,
    sourceSha256: createHash('sha256').update(rawJsonl, 'utf8').digest('hex'),
    publicRegistrySha256,
    verifiedEvents: events.length,
  };
}

export function buildCapabilityShadowSignedReport(
  rawJsonl: string,
  publicRegistryJson: string,
  expectedPublicRegistrySha256: string,
  membership: VerifiedCapabilityShadowMembership,
  split: CapabilityShadowEvent['sample']['split'] | 'all' = 'all',
): { ingestion: CapabilityShadowSignedIngestion; report: CapabilityShadowReport } {
  if (membership.payload.assignments.length > MAX_SIGNED_CAPABILITY_SHADOW_ROWS) throw new Error('signed membership exceeds 2000 assignments');
  const ingestion = ingestCapabilityShadowSignedEvents(rawJsonl, publicRegistryJson, expectedPublicRegistrySha256);
  return { ingestion, report: buildCapabilityShadowReport(ingestion.events, membership, split) };
}
