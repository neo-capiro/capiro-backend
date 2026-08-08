import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src/outreach-v3'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const root = apiRoot();
const engine = readFileSync(
  resolve(root, 'src/outreach-v3/services/outreach-command-engine.service.ts'),
  'utf8',
);
const helper = readFileSync(
  resolve(root, 'src/outreach-v3/persistence/outreach-proposal-supersession.ts'),
  'utf8',
);

describe('Outreach V3 eager proposal supersession audit', () => {
  it('uses the exact UPDATE RETURNING helper rather than an unaudited count-only update', () => {
    expect(helper).toContain('UPDATE outreach_command_proposals');
    expect(helper).toContain('RETURNING id::text AS id');
    expect(helper).toContain("rejection_code = 'state_advanced'");
    expect(helper).not.toMatch(/LIMIT\s+\d+/i);
  });

  it('requires the command transaction to emit a proposal_superseded event for returned ids', () => {
    // This assertion intentionally fails until the command engine consumes the
    // exact returned IDs and appends one safe audit event per eager status
    // transition in the same transaction. Do not weaken/remove this gate to
    // close the finding; wire the helper into the authoritative command path.
    expect(engine).toContain('supersedeStaleOutreachProposals');
    expect(engine).toContain("eventType: 'proposal_superseded'");
  });
});
