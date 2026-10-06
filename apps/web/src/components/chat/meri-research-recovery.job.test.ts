import { describe, expect, it } from 'vitest';
import { readMeriJob, readRecoveredResearch } from './meri-research-recovery.js';

const session = (job?: unknown) => ({
  id: 'research-1',
  title: 'Office brief',
  metadata: { handoff: { conversationId: 'conversation-1' } },
  run: { id: 'run-1', phase: 'research', status: 'running', stage: 'Gathering evidence' },
  ...(job === undefined ? {} : { job }),
});

const job = {
  kind: 'deliverable',
  status: 'executing',
  goalRevision: 1,
  deliverables: [{ format: 'docx', title: 'Office brief', artifactId: null }],
  awaitingStart: false,
};

describe('research recovery keeps the public job view', () => {
  it('keeps a well-formed job block', () => {
    expect(readRecoveredResearch(session(job), 'conversation-1')?.job).toEqual(job);
  });

  it('stays readable when the API sends no job block', () => {
    const recovered = readRecoveredResearch(session(), 'conversation-1');
    expect(recovered?.id).toBe('research-1');
    expect(recovered).not.toHaveProperty('job');
  });

  it('drops a job with an unknown kind, status or deliverable shape', () => {
    expect(readMeriJob({ ...job, kind: 'email' })).toBeNull();
    expect(readMeriJob({ ...job, status: 'done' })).toBeNull();
    expect(readMeriJob({ ...job, goalRevision: -1 })).toBeNull();
    expect(readMeriJob({ ...job, deliverables: [{ format: 'zip', title: 'x', artifactId: null }] })).toBeNull();
    expect(readRecoveredResearch(session({ ...job, kind: 'email' }), 'conversation-1')).not.toHaveProperty(
      'job',
    );
  });
});
