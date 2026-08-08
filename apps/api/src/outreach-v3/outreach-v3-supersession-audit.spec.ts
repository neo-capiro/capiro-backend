import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src/outreach-v3'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const root = apiRoot();
const auditedRepository = readFileSync(
  resolve(root, 'src/outreach-v3/persistence/outreach-audited-state.repository.ts'),
  'utf8',
);
const helper = readFileSync(
  resolve(root, 'src/outreach-v3/persistence/outreach-proposal-supersession.ts'),
  'utf8',
);

describe('Outreach V3 eager proposal supersession audit', () => {
  it('uses exact UPDATE RETURNING rows rather than an unaudited count-only update', () => {
    expect(helper).toContain('UPDATE outreach_command_proposals');
    expect(helper).toContain('RETURNING');
    expect(helper).toContain('id::text AS id');
    expect(helper).toContain('expected_state_version AS "expectedStateVersion"');
    expect(helper).toContain("rejection_code = 'state_advanced'");
    expect(helper).not.toMatch(/LIMIT\s+\d+/i);
  });

  it('emits a proposal_superseded event for every exact returned row', () => {
    expect(auditedRepository).toContain('supersedeStaleOutreachProposals');
    expect(auditedRepository).toContain("eventType: 'proposal_superseded'");
    expect(auditedRepository).toContain("source: 'system'");
    expect(auditedRepository).toContain('proposalId: proposal.id');
    expect(auditedRepository).toContain('expectedStateVersion: proposal.expectedStateVersion');
    expect(auditedRepository).toContain('return superseded.length');
  });
});
