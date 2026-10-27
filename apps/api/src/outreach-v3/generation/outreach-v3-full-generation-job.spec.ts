import { createHash } from 'node:crypto';
import { parseOutreachV3FullGenerationJob } from './outreach-v3-full-generation-job.js';

function storedJob() {
  const base = {
    schemaVersion: 'outreach_v3_full_generation_job_v1',
    sessionId: 'historical-session',
    stateVersion: 1,
    specHash: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    approachApprovalHash: 'c'.repeat(64),
    pinned: {
      provider: 'openai',
      model: 'historical-model',
      planModel: null,
      promptSpecVersion: 'v1',
    },
    items: [{ generationKey: 'slot-a' }],
    batchSize: 10,
  };
  return { ...base, jobKey: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}

describe('historical V3 generation descriptor reads', () => {
  it('retains immutable job identities and their original model attribution', () => {
    const saved = storedJob();
    expect(parseOutreachV3FullGenerationJob(saved)).toEqual(saved);
  });
  it('refuses corrupted or secret-bearing historical descriptors', () => {
    const saved = storedJob();
    expect(parseOutreachV3FullGenerationJob({ ...saved, planHash: 'd'.repeat(64) })).toBeNull();
    expect(
      parseOutreachV3FullGenerationJob({
        ...saved,
        pinned: { ...saved.pinned, apiKey: 'forbidden' },
      }),
    ).toBeNull();
    expect(
      parseOutreachV3FullGenerationJob({ ...saved, items: [...saved.items, ...saved.items] }),
    ).toBeNull();
  });
});
