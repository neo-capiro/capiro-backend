import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');

describe('Florida OpenStates alias repair entrypoint', () => {
  it('exposes the reviewed repair verb in the production image dispatcher', () => {
    expect(dispatcher).toMatch(
      /repair-florida-openstates-aliases\)[\s\S]*repair-florida-openstates-aliases\.ts "\$@"/,
    );
  });

  it('requires the operator to attest that scheduled writers are quiesced', () => {
    const script = readFileSync(join(__dirname, 'repair-florida-openstates-aliases.ts'), 'utf8');
    expect(script).toContain('--writers-quiesced');
    expect(script).toContain('FLORIDA_ALIAS_REPAIR_WRITERS_QUIESCED');
  });
});
