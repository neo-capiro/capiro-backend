import type { AssuredEvidence, LedgerEntry } from '@capiro/meriv2-core';
import { buildRepairPassages } from './meriv3-assistant.service.js';

const sourceId = 'US:119:HR:8800';
const evidence: AssuredEvidence = {
  id: `formb:search_capiro_data:${sourceId}`,
  sourceType: 'search_capiro_data',
  sourceId,
  evidenceClass: 'official_government_data',
  primary: true,
  authoritative: true,
  requirementIds: [],
};

function entry(result: unknown): LedgerEntry {
  return {
    tool: 'search_capiro_data',
    result,
    serialized: JSON.stringify(result),
  };
}

describe('repair passages from model-visible evidence', () => {
  it('does not turn an omitted identity-only hint into a citable passage', () => {
    const hidden = entry({
      records: [],
      complete: false,
      projection: {
        truncated: true,
        identitiesAreNotEvidence: true,
        omittedRecordIdentities: [{ recordId: sourceId }],
      },
    });
    expect(hidden.serialized).toContain(sourceId);
    expect(buildRepairPassages([evidence], [], [hidden])[evidence.id]).toEqual({ text: '' });
  });

  it('can bind the same identity after a narrowed read exposes its record body', () => {
    const hidden = entry({
      records: [],
      projection: { omittedRecordIdentities: [{ recordId: sourceId }] },
    });
    const visible = entry({
      records: [{ domain: 'bills', recordId: sourceId, payload: { title: 'Known bill' } }],
      complete: true,
    });
    expect(buildRepairPassages([evidence], [], [hidden, visible])[evidence.id]).toEqual({
      text: visible.serialized,
    });
  });
});
