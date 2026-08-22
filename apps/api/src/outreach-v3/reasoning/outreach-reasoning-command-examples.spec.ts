import {
  OUTREACH_IMPLEMENTED_COMMAND_TYPES,
  OUTREACH_USER_AUTHORED_COMMAND_TYPES,
  parseOutreachCommandEnvelope,
} from '../state/outreach-command.contract.js';
import { OUTREACH_REASONING_COMMAND_EXAMPLE_PAYLOADS } from './outreach-reasoning-command-examples.js';

describe('OUTREACH_REASONING_COMMAND_EXAMPLE_PAYLOADS', () => {
  const entries = Object.entries(OUTREACH_REASONING_COMMAND_EXAMPLE_PAYLOADS) as Array<
    [string, Record<string, unknown>]
  >;

  it('is non-empty and covers the strategy commands implicated in the reasoning output-invalid bug', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const type of ['SET_CAMPAIGN_ANGLE', 'SET_TONE', 'SET_LENGTH']) {
      expect(OUTREACH_REASONING_COMMAND_EXAMPLE_PAYLOADS).toHaveProperty(type);
    }
  });

  it('only references real, model-proposable implemented command types', () => {
    for (const [type] of entries) {
      expect(OUTREACH_IMPLEMENTED_COMMAND_TYPES as readonly string[]).toContain(type);
      expect(OUTREACH_USER_AUTHORED_COMMAND_TYPES as readonly string[]).not.toContain(type);
    }
  });

  it.each(entries)(
    'the %s example parses through the real command envelope schema unchanged',
    (type, payload) => {
      const envelope = { type, schemaVersion: 1 as const, payload };
      const parsed = parseOutreachCommandEnvelope(envelope);
      expect(parsed).toEqual(envelope);
    },
  );
});
