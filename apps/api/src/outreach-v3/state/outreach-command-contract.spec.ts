import { createBlankCampaignSpecV1, hashCampaignSpecV1 } from './outreach-campaign-spec.v1.js';
import {
  parseOutreachCommandBatch,
  parseOutreachCommandEnvelope,
} from './outreach-command.contract.js';
import {
  hashNormalizedOutreachCommandBatch,
  normalizeOutreachCommandBatch,
  normalizeOutreachCommandEnvelope,
} from './outreach-command-normalization.js';

const clientA = '00000000-0000-4000-8000-000000000010';
const clientB = '00000000-0000-4000-8000-000000000011';

function sponsor(payload: Record<string, unknown>) {
  return {
    type: 'SET_SPONSOR_SCOPE',
    schemaVersion: 1,
    payload,
  };
}

describe('Outreach V3 strict command contract', () => {
  it('normalizes duplicate client sponsor refs before durable command hashing', () => {
    const parsed = parseOutreachCommandEnvelope(
      sponsor({
        kind: 'client',
        label: null,
        clientRefs: [{ clientId: clientA }, { clientId: clientA }],
      }),
    );
    const normalized = normalizeOutreachCommandEnvelope(parsed);
    expect(normalized.payload).toEqual({
      kind: 'client',
      label: null,
      clientRefs: [{ clientId: clientA }],
    });
    expect(() => parseOutreachCommandEnvelope(normalized)).not.toThrow();
  });

  it('rejects sponsor cardinality and coalition-label errors before persistence', () => {
    expect(() =>
      parseOutreachCommandEnvelope(
        sponsor({ kind: 'client', label: null, clientRefs: [] }),
      ),
    ).toThrow();
    expect(() =>
      parseOutreachCommandEnvelope(
        sponsor({
          kind: 'multi_client',
          label: null,
          clientRefs: [{ clientId: clientA }, { clientId: clientA }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOutreachCommandEnvelope(
        sponsor({ kind: 'coalition', label: '   ', clientRefs: [] }),
      ),
    ).toThrow();
    expect(() =>
      parseOutreachCommandEnvelope(
        sponsor({ kind: 'firm', label: null, clientRefs: [{ clientId: clientA }] }),
      ),
    ).toThrow();
  });

  it('accepts valid multi-client and coalition sponsor commands', () => {
    expect(() =>
      parseOutreachCommandEnvelope(
        sponsor({
          kind: 'multi_client',
          label: null,
          clientRefs: [{ clientId: clientB }, { clientId: clientA }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseOutreachCommandEnvelope(
        sponsor({ kind: 'coalition', label: 'Coalition for Readiness', clientRefs: [] }),
      ),
    ).not.toThrow();
  });

  it('rejects disallowed control characters in command text and criteria', () => {
    expect(() =>
      parseOutreachCommandEnvelope({
        type: 'SET_GOAL',
        schemaVersion: 1,
        payload: { value: 'valid\u0000hidden' },
      }),
    ).toThrow();
    expect(() =>
      parseOutreachCommandEnvelope({
        type: 'SET_TARGET_CRITERIA',
        schemaVersion: 1,
        payload: {
          value: {
            notes: null,
            governmentLevels: ['federal'],
            chambers: ['senate'],
            committees: ['Armed\u0007Services'],
            agencies: [],
            states: [],
            relationshipPreference: 'any',
            includeStaff: true,
            includePrincipals: true,
          },
        },
      }),
    ).toThrow();
  });

  it('hashes logically equivalent set-like commands identically', () => {
    const first = parseOutreachCommandBatch({
      batchId: '00000000-0000-4000-8000-000000000100',
      expectedStateVersion: 1,
      commands: [
        {
          type: 'SET_TARGET_CRITERIA',
          schemaVersion: 1,
          payload: {
            value: {
              notes: '  Priority  ',
              governmentLevels: ['state', 'federal', 'state'],
              chambers: ['senate', 'house'],
              committees: ['Översight', 'Appropriations', 'Översight'],
              agencies: ['DoD', 'DHS'],
              states: ['VA', 'CA'],
              relationshipPreference: 'any',
              includeStaff: true,
              includePrincipals: true,
            },
          },
        },
      ],
    });
    const second = parseOutreachCommandBatch({
      batchId: first.batchId,
      expectedStateVersion: 1,
      commands: [
        {
          type: 'SET_TARGET_CRITERIA',
          schemaVersion: 1,
          payload: {
            value: {
              notes: 'Priority',
              governmentLevels: ['federal', 'state'],
              chambers: ['house', 'senate'],
              committees: ['Appropriations', 'Översight'],
              agencies: ['DHS', 'DoD'],
              states: ['CA', 'VA'],
              relationshipPreference: 'any',
              includeStaff: true,
              includePrincipals: true,
            },
          },
        },
      ],
    });
    expect(hashNormalizedOutreachCommandBatch(first)).toBe(
      hashNormalizedOutreachCommandBatch(second),
    );
    expect(normalizeOutreachCommandBatch(first)).toEqual(normalizeOutreachCommandBatch(second));
  });

  it('keeps command order significant while object/set ordering is canonical', () => {
    const batchId = '00000000-0000-4000-8000-000000000101';
    const first = parseOutreachCommandBatch({
      batchId,
      expectedStateVersion: 1,
      commands: [
        { type: 'SET_GOAL', schemaVersion: 1, payload: { value: 'A' } },
        { type: 'SET_GOAL', schemaVersion: 1, payload: { value: 'B' } },
      ],
    });
    const reversed = parseOutreachCommandBatch({
      batchId,
      expectedStateVersion: 1,
      commands: [...first.commands].reverse(),
    });
    expect(hashNormalizedOutreachCommandBatch(first)).not.toBe(
      hashNormalizedOutreachCommandBatch(reversed),
    );
  });

  it('keeps Campaign Spec hashes stable across Unicode set ordering', () => {
    const blank = createBlankCampaignSpecV1();
    const one = {
      ...blank,
      targeting: {
        ...blank.targeting,
        criteria: {
          notes: null,
          governmentLevels: ['federal'],
          chambers: ['senate'],
          committees: ['Översight', 'Appropriations'],
          agencies: ['DoD'],
          states: ['VA'],
          relationshipPreference: 'any',
          includeStaff: true,
          includePrincipals: true,
        },
      },
    };
    const two = {
      ...one,
      targeting: {
        ...one.targeting,
        criteria: {
          ...one.targeting.criteria,
          committees: ['Appropriations', 'Översight'],
        },
      },
    };
    expect(hashCampaignSpecV1(one)).toBe(hashCampaignSpecV1(two));
  });
});
