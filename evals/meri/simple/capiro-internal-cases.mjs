// Capiro-internal adaptations of the original cases (evals/meri/live-v1/cases.mjs).
// The behavior and pass condition are the original's; the client and records are
// real capiro-internal ones (L3 Harris has the most approved memory; Anduril is
// the second client used for scope checks). State-changing setup only ever uses
// the test client "ZZ-QA-Meri1651-Test-DoNotUse". `mode` is LIVE, TEST or PENDING
// (adaptation needs setup not yet seeded).
export const PRIMARY = 'L3 Harris';
export const SECOND = 'Anduril';
export const QA_CLIENT = 'ZZ-QA-Meri1651-Test-DoNotUse';

const live = (id, client, prompt, extra = {}) => ({ id, mode: 'LIVE', client, turns: [{ prompt }], op: 'read', ...extra });
const test = (id, why) => ({ id, mode: 'TEST', why });
const pending = (id, why) => ({ id, mode: 'PENDING', why });

export const internalCases = [
  live('01', PRIMARY, 'What do we know about L3 Harris’s briefing preferences?', { citations: true }),
  pending('02', 'needs a pending memory candidate on the QA client'),
  pending('03', 'needs a revoked memory on the QA client'),
  pending('04', 'needs a superseded memory version on the QA client'),
  live('05', PRIMARY, 'Summarize what we know about this client.', { citations: true }),
  test('06', 'cross-tenant isolation: one capiro_admin account cannot stand in for a T1-only user'),
  test('07', 'ethical wall: needs a walled non-admin user'),
  live('08', null, 'Remember how I like my own answers formatted.'),
  live('09', null, 'What is our firmwide citation policy?'),
  {
    id: '10', mode: 'LIVE', client: PRIMARY, op: 'read', citations: true,
    turns: [
      { prompt: 'How should L3 Harris’s next brief look?' },
      { prompt: 'Now switch to Anduril. How should its next brief look?', switchClient: SECOND, mustNotMention: [PRIMARY, 'L3Harris'] },
    ],
  },
  live('11', PRIMARY, 'Did L3 Harris win the award today, based on what we remember?'),
  test('12', 'retrieval past a 500-candidate cap needs 500 seeded candidates'),
];
