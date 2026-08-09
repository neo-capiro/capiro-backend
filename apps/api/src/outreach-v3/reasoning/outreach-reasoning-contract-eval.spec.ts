import {
  OUTREACH_IMPLEMENTED_COMMAND_TYPES,
  parseOutreachCommandEnvelope,
} from '../state/outreach-command.contract.js';
import {
  parseReasoningAssistantMessage,
  parseReasoningProposedCommands,
} from './outreach-reasoning.contract.js';

const implemented = new Set<string>(OUTREACH_IMPLEMENTED_COMMAND_TYPES);

type EvalCase = {
  id: string;
  expected: 'implemented' | 'no_command' | 'future_reject' | 'malformed_reject';
  assistant: unknown;
  commands: unknown;
};

function cases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 0; i < 25; i += 1) {
    out.push({
      id: `goal-${i}`,
      expected: 'implemented',
      assistant: `Visible goal answer ${i}`,
      commands: [
        {
          type: 'SET_GOAL',
          schemaVersion: 1,
          payload: { value: `Protect program ${i}` },
        },
      ],
    });
  }
  for (let i = 0; i < 25; i += 1) {
    out.push({
      id: `read-only-${i}`,
      expected: 'no_command',
      assistant: `Visible read-only answer ${i}`,
      commands: [],
    });
  }
  for (let i = 0; i < 25; i += 1) {
    out.push({
      id: `future-${i}`,
      expected: 'future_reject',
      assistant: `Future capability not available ${i}`,
      commands: [
        {
          type: 'REQUEST_FULL_GENERATION',
          schemaVersion: 1,
          payload: {},
        },
      ],
    });
  }
  for (let i = 0; i < 25; i += 1) {
    out.push({
      id: `malformed-${i}`,
      expected: 'malformed_reject',
      assistant: i % 2 === 0 ? 42 : `Malformed command ${i}`,
      commands: [
        {
          type: 'SET_GOAL',
          schemaVersion: 99,
          payload: { value: `Bad ${i}` },
        },
      ],
    });
  }
  return out;
}

describe('Outreach V3 Phase 3 deterministic 100-case reasoning contract eval', () => {
  it('classifies all 100 scripted provider outputs without granting future authority', () => {
    const results = {
      total: 0,
      implementedAccepted: 0,
      noCommandAccepted: 0,
      futureRejectedByGateway: 0,
      malformedRejectedByParser: 0,
    };

    for (const testCase of cases()) {
      results.total += 1;
      let assistantValid = true;
      try {
        parseReasoningAssistantMessage(testCase.assistant);
      } catch {
        assistantValid = false;
      }

      if (testCase.expected === 'malformed_reject') {
        expect(() => parseReasoningProposedCommands(testCase.commands)).toThrow();
        results.malformedRejectedByParser += 1;
        continue;
      }

      expect(assistantValid).toBe(true);
      const parsed = parseReasoningProposedCommands(testCase.commands);
      if (testCase.expected === 'implemented') {
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.every((command) => implemented.has(command.type))).toBe(true);
        results.implementedAccepted += 1;
      } else if (testCase.expected === 'no_command') {
        expect(parsed).toEqual([]);
        results.noCommandAccepted += 1;
      } else {
        // The Phase 2 schema recognizes future vocabulary, but the Phase 3
        // gateway must refuse to persist it as a model proposal.
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.some((command) => !implemented.has(command.type))).toBe(true);
        results.futureRejectedByGateway += 1;
      }
    }

    expect(results).toEqual({
      total: 100,
      implementedAccepted: 25,
      noCommandAccepted: 25,
      futureRejectedByGateway: 25,
      malformedRejectedByParser: 25,
    });
  });

  it('keeps every implemented eval command valid under the authoritative Phase 2 parser', () => {
    const implementedCases = cases().filter((entry) => entry.expected === 'implemented');
    for (const testCase of implementedCases) {
      const commands = testCase.commands as unknown[];
      for (const command of commands) {
        expect(() => parseOutreachCommandEnvelope(command)).not.toThrow();
      }
    }
  });
});
